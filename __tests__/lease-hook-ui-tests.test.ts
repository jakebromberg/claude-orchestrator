import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireLease, type LeaseOptions } from "../src/lease.js";
import { runHook } from "../src/lease-hook.js";
import { isolatedLeaseEnv, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

// Issue #324, defect 2, in hook mode: a Bash call that runs a UI-test action takes a slot of the UI-test class and one of
// the heavy class, both under the call's holder id, and PostToolUse releases both. Text that only mentions the words is not heavy at all.

const SESSION = 7001;
const UI = "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'";

describe("hook mode and the UI-test class", () => {
  let tmp: string;
  let dir: string;
  let scripted: ScriptedLease;
  const names = (sub: string): string[] => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []);
  const call = (event: string, command: string, id = "toolu_1", timeout?: number): string =>
    JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_use_id: id, cwd: "/work", tool_input: { command, ...(timeout && { timeout }) } });

  const run = async (stdin: string, lease: Partial<LeaseOptions> = {}): Promise<string> => {
    const env = isolatedLeaseEnv(dir, { CO_LEASE_HOOK: "on", CO_LEASE_SESSION_PID: String(SESSION), BASH_DEFAULT_TIMEOUT_MS: undefined });
    let out = "";
    const { dir: _d, policy: _p, warn: _w, ...injected } = scripted.opts(lease);
    await runHook([], { env, readStdin: async () => stdin, out: (t) => void (out += t), lease: injected, heavyQueuePath: join(tmp, "no-heavy-queue") });
    return out;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-hook-ui-"));
    dir = join(tmp, "lease");
    scripted = scriptedLease(dir, { alive: [SESSION], policy: { heavyCeiling: 4, heavyWarning: 4 } });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("takes both slots for a real invocation and PostToolUse releases both", async () => {
    expect(await run(call("PreToolUse", UI))).toContain("lease: admitted");
    expect(names("ui-tests")).toEqual(["hook-toolu_1.json"]);
    expect(names("holders")).toEqual(["hook-toolu_1.json"]);
    await run(call("PostToolUse", UI));
    expect(names("ui-tests")).toEqual([]);
    expect(names("holders")).toEqual([]);
  });

  it("releases both on PostToolUseFailure", async () => {
    await run(call("PreToolUse", UI));
    await run(call("PostToolUseFailure", UI));
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it("takes only a heavy slot for an ordinary heavy command", async () => {
    await run(call("PreToolUse", "npm test"));
    expect(names("ui-tests")).toEqual([]);
    expect(names("holders")).toEqual(["hook-toolu_1.json"]);
  });

  it("takes only a heavy slot for a build action", async () => {
    await run(call("PreToolUse", "xcodebuild build -scheme App"));
    expect([names("ui-tests"), names("holders")]).toEqual([[], ["hook-toolu_1.json"]]);
  });

  it("takes no slot for a command that only mentions the words", async () => {
    expect(await run(call("PreToolUse", 'grep -rn "xcodebuild test" docs/'))).toBe("");
    expect(await run(call("PreToolUse", 'gh issue create --title t --body "run xcodebuild test -scheme App"', "toolu_2"))).toBe("");
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it("denies a second run after 450 s instead of running it, and leaves the first run's slots alone", async () => {
    // The first call outlives the second one's 450 s wait.
    await run(call("PreToolUse", UI, "toolu_1", 600_000));
    scripted.alive.add(SESSION);
    const out = await run(call("PreToolUse", UI, "toolu_2"));
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(names("ui-tests")).toEqual(["hook-toolu_1.json"]);
    expect(names("holders")).toEqual(["hook-toolu_1.json"]);
    expect(scripted.clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(450_000 - 4_000);
  });

  it("does not make an unrelated heavy command wait behind a queued UI-test run", async () => {
    await run(call("PreToolUse", UI));
    let probed = false;
    scripted.clock.onSleep = () => {
      if (probed) return;
      probed = true;
      const other = tryAcquireLease(scripted.opts(), { command: "npm test", cwd: "/work" });
      expect(other).toMatchObject({ leased: true });
      other!.release();
    };
    await run(call("PreToolUse", UI, "toolu_2"));
    expect(probed).toBe(true);
  });
});
