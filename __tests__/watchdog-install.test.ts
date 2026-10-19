import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISK_FULL_FRACTION } from "../src/watchdog.js";
import { isGitWorktree, plistText, runPrint, statusLineSnippet, type PrintDeps } from "../src/watchdog-install.js";

const LEASE = "/Users/me/.local/state/claude-orchestrator";

describe("plistText", () => {
  const text = plistText({ node: "/opt/homebrew/bin/node", checkout: "/Users/me/Developer/claude-orchestrator", dir: LEASE });

  it("runs check under taskpolicy -b with absolute paths", () => {
    expect(text).toContain("<string>/usr/sbin/taskpolicy</string>\n    <string>-b</string>\n    <string>/opt/homebrew/bin/node</string>");
    expect(text).toContain("<string>/Users/me/Developer/claude-orchestrator/dist/src/cli-watchdog.js</string>\n    <string>check</string>");
  });

  it("runs every 120 s and sends stderr to watchdog.err in the lease directory", () => {
    expect(text).toContain("<key>StartInterval</key>\n  <integer>120</integer>");
    expect(text).toContain(`<key>StandardErrorPath</key>\n  <string>${LEASE}/watchdog.err</string>`);
  });

  it("escapes XML in paths", () => {
    expect(plistText({ node: "/a&b/node", checkout: "/c", dir: "/d" })).toContain("<string>/a&amp;b/node</string>");
  });
});

describe("statusLineSnippet", () => {
  const snippet = statusLineSnippet(LEASE, 0.02);

  it("reads watchdog.brief in the shell and falls back to nothing when it is missing", () => {
    expect(snippet).toContain(`cat '${LEASE}/watchdog.brief' 2>/dev/null`);
  });

  it("checks the lease volume with df -k against the substituted fraction, without node", () => {
    expect(snippet).toContain(`df -k '${LEASE}'`);
    expect(snippet).toContain("f=0.02");
    expect(snippet).not.toMatch(/\bnode\b/);
  });

  it("prints the disk line text of brief", () => {
    expect(snippet).toContain("the disk holding %s is nearly full (%.1f%% free); heavy commands are refused once the lease cannot write");
  });

  it("quotes a directory with a single quote", () => {
    expect(statusLineSnippet("/a'b", 0.02)).toContain(`'/a'\\''b/watchdog.brief'`);
  });

  it("behaves in a real shell: silent with no brief and ample space, brief text when present", async () => {
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "wd-snippet-"));
    try {
      const run = () => execFileSync("/bin/sh", ["-c", statusLineSnippet(dir, 0.02)], { encoding: "utf-8" });
      expect(run()).toBe("");
      writeFileSync(join(dir, "watchdog.brief"), "watchdog: stopped");
      expect(run()).toBe("watchdog: stopped\n");
      expect(execFileSync("/bin/sh", ["-c", statusLineSnippet(dir, 1.01)], { encoding: "utf-8" })).toContain("is nearly full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isGitWorktree", () => {
  it("is true when .git is a file, false for a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wd-wt-"));
    try {
      mkdirSync(join(root, "primary/.git"), { recursive: true });
      mkdirSync(join(root, "linked"));
      writeFileSync(join(root, "linked/.git"), "gitdir: /x");
      expect(isGitWorktree(join(root, "primary"))).toBe(false);
      expect(isGitWorktree(join(root, "linked"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runPrint", () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps = (over: Partial<PrintDeps> = {}): PrintDeps => ({ dir: LEASE, node: "/n/node", checkout: "/c", isWorktree: () => false, out: (l) => out.push(l), err: (l) => err.push(l), ...over });

  it("ignores other subcommands", () => {
    expect(runPrint(["check"], deps())).toBeUndefined();
  });

  it("prints the plist and the snippet", () => {
    out.length = 0;
    expect(runPrint(["print-plist"], deps())).toBe(0);
    expect(out.join("\n")).toContain("<integer>120</integer>");
    out.length = 0;
    expect(runPrint(["print-status-line"], deps())).toBe(0);
    expect(out.join("\n")).toContain(`f=${DISK_FULL_FRACTION}`);
  });

  it("refuses to print the plist from a git worktree", () => {
    out.length = 0;
    err.length = 0;
    expect(runPrint(["print-plist"], deps({ isWorktree: () => true }))).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/worktree/);
  });
});
