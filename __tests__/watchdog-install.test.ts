import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISK_FULL_FRACTION } from "../src/watchdog.js";
import { checkoutOf, isGitWorktree, plistText, runPrint, START_INTERVAL_S, STALE_AFTER_INTERVALS, statusLineSnippet, type PrintDeps } from "../src/watchdog-install.js";

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

  it("pins the print-time lease directory as CO_LEASE_DIR, so check writes where the status line reads", () => {
    expect(text).toContain(`<key>EnvironmentVariables</key>\n  <dict>\n    <key>CO_LEASE_DIR</key>\n    <string>${LEASE}</string>\n  </dict>`);
  });

  it("escapes XML in paths", () => {
    const escaped = plistText({ node: "/a&b/node", checkout: "/c", dir: "/d<&>" });
    expect(escaped).toContain("<string>/a&amp;b/node</string>");
    expect(escaped).toContain("<key>CO_LEASE_DIR</key>\n    <string>/d&lt;&amp;&gt;</string>");
  });
});

describe("statusLineSnippet", () => {
  const snippet = statusLineSnippet(LEASE, 0.02);

  it("reads watchdog.brief in the shell and falls back to nothing when it is missing", () => {
    expect(snippet).toContain(`cat '${LEASE}/watchdog.brief' 2>/dev/null`);
  });

  it("checks the lease volume with POSIX df -Pk against the substituted fraction, without node", () => {
    expect(snippet).toContain(`df -Pk '${LEASE}'`);
    expect(snippet).toContain("f=0.02");
    expect(snippet).not.toMatch(/\bnode\b/);
  });

  it("prints the disk line text of brief", () => {
    expect(snippet).toContain("the disk holding %s is nearly full (%.1f%% free); heavy commands are refused once the lease cannot write");
  });

  it("quotes a directory with a single quote", () => {
    expect(statusLineSnippet("/a'b", 0.02)).toContain(`'/a'\\''b/watchdog.brief'`);
  });

  it("behaves in a real shell: silent with no brief at fraction 0, brief text when present, disk line above 100%", async () => {
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "wd-snippet-"));
    try {
      writeFileSync(join(dir, "watchdog.json"), "{}");
      const run = () => execFileSync("/bin/sh", ["-c", statusLineSnippet(dir, 0)], { encoding: "utf-8" });
      expect(run()).toBe("");
      writeFileSync(join(dir, "watchdog.brief"), "watchdog: stopped");
      expect(run()).toBe("watchdog: stopped\n");
      expect(execFileSync("/bin/sh", ["-c", statusLineSnippet(dir, 1.01)], { encoding: "utf-8" })).toContain("is nearly full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statusLineSnippet staleness", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "wd-stale-"));
  const run = async (d: string) => (await import("node:child_process")).execFileSync("/bin/sh", ["-c", statusLineSnippet(d, 0)], { encoding: "utf-8" });
  const ageBy = (d: string, s: number) => {
    const t = Date.now() / 1000 - s;
    utimesSync(join(d, "watchdog.json"), t, t);
  };

  it("derives its threshold from the plist's StartInterval", () => {
    expect(plistText({ node: "n", checkout: "/c", dir: LEASE })).toContain(`<integer>${START_INTERVAL_S}</integer>`);
    expect(statusLineSnippet(LEASE, 0.02)).toContain(`-gt ${START_INTERVAL_S * STALE_AFTER_INTERVALS}`);
  });

  it.each([
    ["fresh", 10, /^$/],
    ["just inside the threshold", START_INTERVAL_S * STALE_AFTER_INTERVALS - 30, /^$/],
    ["stale", START_INTERVAL_S * STALE_AFTER_INTERVALS + 60, /^watchdog: has not run since \d{2}:\d{2}[^\n]*print-plist[^\n]*\n$/],
  ])("watchdog.json %s", async (_n, age, expected) => {
    const d = dir();
    try {
      writeFileSync(join(d, "watchdog.json"), "{}");
      ageBy(d, age);
      expect(await run(d)).toMatch(expected);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("prints one line when watchdog.json is missing from an existing lease directory", async () => {
    const d = dir();
    try {
      expect(await run(d)).toMatch(/^watchdog: watchdog\.json is missing[^\n]*print-plist[^\n]*\n$/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("prints nothing when the lease directory does not exist, and spawns no node", async () => {
    expect(await run(join(tmpdir(), "wd-no-such-dir"))).toBe("");
    expect(statusLineSnippet(LEASE, 0.02)).not.toMatch(/\bnode\b/);
  });
});

describe("isGitWorktree", () => {
  it.each([
    ["a primary checkout (.git directory)", null, false],
    ["a linked worktree", "gitdir: /r/.git/worktrees/wt\n", true],
    ["a submodule", "gitdir: ../.git/modules/sub\n", false],
    ["a --separate-git-dir checkout", "gitdir: /elsewhere/repo.git\n", false],
    ["no .git at all", undefined, false],
  ] as const)("%s → %s", (_name, gitFile, expected) => {
    const root = mkdtempSync(join(tmpdir(), "wd-wt-"));
    try {
      if (gitFile === null) mkdirSync(join(root, ".git"));
      else if (gitFile !== undefined) writeFileSync(join(root, ".git"), gitFile);
      expect(isGitWorktree(root)).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkoutOf", () => {
  it("is two levels above the bin's directory (dist/src/cli-watchdog.js)", () => {
    expect(checkoutOf("/Users/me/Developer/claude-orchestrator/dist/src/cli-watchdog.js")).toBe("/Users/me/Developer/claude-orchestrator");
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
