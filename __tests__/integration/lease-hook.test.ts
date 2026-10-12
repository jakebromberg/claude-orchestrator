import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedLeaseEnv } from "../helpers/lease.js";

/**
 * Hook mode against the built `dist/`. The env is always isolated (a temp lease directory), so nothing here can
 * touch the machine's real lease directory.
 */

const distCli = fileURLToPath(new URL("../../dist/src/cli-lease.js", import.meta.url));

interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: (err?.code as number | undefined) ?? 0, stdout, stderr });
    });
    // A gated-off or filtered settings line exits without reading stdin, so the write can hit EPIPE (Linux reports it
    // reliably); that is the behaviour under test, not a failure.
    child.stdin!.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") reject(err); });
    child.stdin!.end(stdin);
  });
}

const hookInput = (command: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...over });

describe("lease hook mode (integration)", () => {
  let leaseDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    leaseDir = mkdtempSync(join(tmpdir(), "lease-hook-int-"));
    env = isolatedLeaseEnv(leaseDir, { CO_LEASE_HOOK: "on" });
  });
  afterEach(() => rmSync(leaseDir, { recursive: true, force: true }));

  it.each<[string, string]>([
    ["a heavy call", hookInput("npm test")],
    ["a light call", hookInput("ls")],
    ["a non-Bash tool", hookInput("npm test", { tool_name: "Edit" })],
    ["malformed input", "{not json"],
    ["empty input", ""],
  ])("exits 0 with no output for %s", async (_name, stdin) => {
    expect(await run("node", [distCli, "hook"], env, stdin)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("exports the matcher from the package index", async () => {
    const index = fileURLToPath(new URL("../../dist/src/index.js", import.meta.url));
    const { isHeavyCommand } = (await import(index)) as typeof import("../../src/index.js");
    expect([isHeavyCommand("npm test"), isHeavyCommand("ls")]).toEqual([true, false]);
  });

  it("exits 0 with no output when CO_LEASE_DIR is relative", async () => {
    expect(await run("node", [distCli, "hook"], { ...env, CO_LEASE_DIR: "relative/dir" }, hookInput("npm test"))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("prints entries that point at the printing build, not CO_HOME", async () => {
    const printed = await run("node", [distCli, "hook", "--print-settings-entry"], { ...env, CO_HOME: "/elsewhere/claude-orchestrator" });
    expect(printed.code).toBe(0);
    expect(printed.stderr).toBe("");
    const { hooks } = JSON.parse(printed.stdout) as { hooks: Record<string, { matcher: string; hooks: { command: string; timeout?: number }[] }[]> };
    expect(Object.keys(hooks)).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
    expect(hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(500);
    for (const [entry] of Object.values(hooks)) {
      expect(entry!.matcher).toBe("Bash");
      expect(entry!.hooks[0]!.command).toContain(` exec node '${distCli}' hook`);
      expect(entry!.hooks[0]!.command).not.toContain("elsewhere");
    }
  });

  it("runs the printed command under sh: silent exit 0 gated off, filtered out, and through to the CLI", async () => {
    const { hooks } = JSON.parse((await run("node", [distCli, "hook", "--print-settings-entry"], env)).stdout) as {
      hooks: { PreToolUse: [{ hooks: [{ command: string }] }] };
    };
    const command = hooks.PreToolUse[0].hooks[0].command;
    for (const [extra, stdin] of [
      [{ CO_LEASE_HOOK: "" }, hookInput("npm test")],
      [{}, hookInput("ls")],
      [{}, hookInput("npm test")],
      [{ CO_LEASE_PATTERNS_FILE: join(leaseDir, "missing.json") }, hookInput("ls")],
    ] as const) {
      expect(await run("sh", ["-c", command], { ...env, ...extra }, stdin)).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("runs the printed command under /bin/sh from this process: its parent PID is the holder's liveness PID, and the Post event releases it", async () => {
    const { hooks } = JSON.parse((await run("node", [distCli, "hook", "--print-settings-entry"], env)).stdout) as {
      hooks: Record<"PreToolUse" | "PostToolUse", [{ hooks: [{ command: string }] }]>;
    };
    const holder = join(leaseDir, "holders", "hook-toolu_sh.json");
    const entry = (event: "PreToolUse" | "PostToolUse"): string => hooks[event][0].hooks[0].command;
    const pre = await run("/bin/sh", ["-c", entry("PreToolUse")], env, hookInput("npm test", { tool_use_id: "toolu_sh" }));
    expect(pre.code).toBe(0);
    expect(pre.stderr).toBe("");
    expect(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext).toMatch(/^lease: admitted after 0s \(pressure=\w+, 1\/1 live\)$/);
    expect(JSON.parse(readFileSync(holder, "utf8"))).toMatchObject({ id: "hook-toolu_sh", pid: process.pid });
    const post = await run("/bin/sh", ["-c", entry("PostToolUse")], env, hookInput("npm test", { tool_use_id: "toolu_sh", hook_event_name: "PostToolUse" }));
    expect(post).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(holder)).toBe(false);
  });
});
