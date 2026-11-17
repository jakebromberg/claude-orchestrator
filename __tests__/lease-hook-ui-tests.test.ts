import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  const run = async (stdin: string, lease: Partial<LeaseOptions> = {}, envOver: NodeJS.ProcessEnv = {}, shim = false): Promise<string> => {
    const env = isolatedLeaseEnv(dir, { CO_LEASE_HOOK: "on", CO_LEASE_SESSION_PID: String(SESSION), BASH_DEFAULT_TIMEOUT_MS: undefined, ...envOver });
    let out = "";
    const { dir: _d, policy: _p, warn: _w, ...injected } = scripted.opts(lease);
    // With `shim`, the file at the heavy-queue path is the front-end shim, so `heavy-queue run` leases for itself.
    if (shim) writeFileSync(join(tmp, "heavy-queue"), "#!/bin/sh\nexec node cli-heavy-queue.js \"$@\"\n");
    await runHook([], { env, readStdin: async () => stdin, out: (t) => void (out += t), lease: injected, heavyQueuePath: join(tmp, shim ? "heavy-queue" : "no-heavy-queue") });
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

  // Issue #324 review: these are UI runs the heavy matcher does not see (`xcrun` followed by an option), so the UI-test check is its own gate.
  it.each([
    ["xcrun --sdk iphonesimulator", "xcrun --sdk iphonesimulator xcodebuild test -scheme App"],
    ["xcrun -sdk iphonesimulator", "xcrun -sdk iphonesimulator xcodebuild test -scheme App"],
    ["xcrun --toolchain swift", "cd /w && xcrun --toolchain swift xcodebuild test-without-building -xctestrun x"],
  ])("leases both slots for %s", async (_name, command) => {
    expect(await run(call("PreToolUse", command))).toContain("lease: admitted");
    expect([names("ui-tests"), names("holders")]).toEqual([["hook-toolu_1.json"], ["hook-toolu_1.json"]]);
    await run(call("PostToolUse", command));
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  // Issue #324 review: with the tokenizer a command is exempt only when the simple command that runs the UI test is itself an argument of the lease CLI or
  // `heavy-queue run`. A mention in another command, a comment or a sibling segment is not an exemption: the UI run beside it is leased.
  it.each([
    ["the lease CLI with an argv", "claude-orchestrator-lease -- xcrun --sdk iphonesimulator xcodebuild test"],
    ["the lease CLI with --shell", "claude-orchestrator-lease --shell 'cd /w && xcodebuild test -scheme A'"],
    ["the built bin by path", "node /opt/co/dist/src/cli-lease.js -- xcodebuild -scheme A test"],
    ["heavy-queue with the shim", "heavy-queue run --shell 'xcodebuild test -scheme A'"],
    ["heavy-queue with the shim and an argv", "heavy-queue run -- xcodebuild -scheme A test"],
  ])("leases nothing for %s, which leases for itself", async (_name, command) => {
    expect(await run(call("PreToolUse", command), {}, {}, true)).toBe("");
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it.each([
    ["a sibling command that mentions the CLI", `claude-orchestrator-lease status; ${UI}`],
    ["an echo of the CLI before it", `echo claude-orchestrator-lease && ${UI}`],
    ["a comment that mentions the CLI", `${UI} # see claude-orchestrator-lease`],
    ["a comment on an earlier line", `# claude-orchestrator-lease\n${UI}`],
    ["a quoted mention in another command", `echo 'cli-lease.js' && xcrun --sdk iphonesimulator ${UI}`],
    ["heavy-queue run for another command", `heavy-queue run --shell 'npm run lint' && ${UI}`],
    ["a heavy-queue status", `heavy-queue run -- ls && ${UI}`],
  ])("still leases both slots for a UI run beside %s", async (_name, command) => {
    expect(await run(call("PreToolUse", command), {}, {}, true)).toContain("lease: admitted");
    expect([names("ui-tests"), names("holders")]).toEqual([["hook-toolu_1.json"], ["hook-toolu_1.json"]]);
  });

  it("keeps the whole-text exemption for text it cannot tokenize", async () => {
    expect(await run(call("PreToolUse", `echo 'unterminated claude-orchestrator-lease; ${UI}`))).toBe("");
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  // PostToolUse fires when the backgrounded shell returns, so its slots would be released at once while the test still runs, and a second UI
  // run would be admitted beside it. This PR has no tokenizer, so the check is conservative: any unquoted single `&` that is not part of `&&`,
  // `>&`, `<&`, `&>` or `|&` anywhere in a UI-test call denies it.
  it.each([
    ["a trailing &", `${UI} &`],
    ["a trailing & after a redirect", `${UI} > out.log 2>&1 &`],
    ["a trailing & and whitespace", `${UI}  &  `],
    ["a & that is followed by another command", `${UI} > x.log 2>&1 & echo $!`],
    ["a & that is followed by sleep", `${UI} & sleep 5`],
    ["a subshell that backgrounds it", `(${UI} &)`],
    ["a group that backgrounds it", `{ ${UI} & }`],
    ["a pipeline element that is backgrounded", `${UI} | tee out.log &`],
    ["a backgrounded subshell", `(${UI}) &`],
    ["a wrapper around it", `taskpolicy -b ${UI} &`],
    ["a lone & after a quoted &", `echo 'a & b' && ${UI} &`],
  ])("denies a UI-test call that backgrounds with %s, asks for the foreground, and takes no slot", async (_name, command) => {
    const out = JSON.parse(await run(call("PreToolUse", command)));
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("foreground");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/^lease: no slot after 0s: /);
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it.each([
    ["a && between commands", `cd /w && ${UI}`],
    ["a redirect that holds a &", `${UI} 2>&1 | tail`],
    ["&> as a redirect", `${UI} &>build.log`],
    ["|& as a pipe", `${UI} |& tail`],
    ["<& as a redirect", `${UI} <&3`],
    ["a >& redirect", `${UI} >&build.log`],
    ["a & inside single quotes", `${UI} -destination 'name=A & B'`],
    ["a & inside double quotes", `${UI} -scheme "A & B"`],
    ["an escaped &", `${UI} -scheme A\\&B`],
    ["a trailing && that continues the line", `${UI} &&`],
    // The tokenizer knows which command a & backgrounds: here it backgrounds something else, and the UI run is in the foreground.
    ["a & that backgrounds an earlier command", `echo hi & ${UI}`],
    ["a & on an earlier line", `echo hi &\n${UI}`],
    ["a & after a ; that ends the run's statement", `${UI}; echo hi &`],
  ])("does not deny %s", async (_name, command) => {
    const out = await run(call("PreToolUse", command));
    expect(out).not.toContain("foreground");
  });

  it.each([
    ["an if", `if true; then ${UI}; fi &`],
    ["a for loop", `for s in A B; do ${UI}; done > log 2>&1 &`],
    ["a while loop", `while true; do ${UI}; done &`],
    ["an until loop", `until false; do ${UI}; done &`],
    ["a case", `case $x in a) ${UI} ;; esac &`],
    ["a function whose call is backgrounded", `f() { ${UI}; }; f &`],
    ["a coproc", `coproc ${UI}`],
    ["an output process substitution", `tee out.log >(${UI})`],
  ])("denies a UI-test call that backgrounds the run through %s", async (_name, command) => {
    const out = JSON.parse(await run(call("PreToolUse", command)));
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("foreground");
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it("does not deny a heavy command that is not a UI run, whatever it does with &", async () => {
    expect(await run(call("PreToolUse", "npm test &"))).not.toContain("foreground");
  });

  // A UI call with run_in_background set is a refusal of the UI class too: the standard prefix, and the same advice.
  it("denies a UI-test call with run_in_background with the no-slot prefix, and a heavy one with the plain text", async () => {
    const ui = JSON.parse(await run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1", cwd: "/work", tool_input: { command: UI, run_in_background: true } })));
    expect(ui.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(ui.hookSpecificOutput.permissionDecisionReason).toMatch(/^lease: no slot after 0s: run a UI test in the foreground/);
    expect(ui.hookSpecificOutput.permissionDecisionReason).toContain("rerunning the same command will not help");
    const heavy = JSON.parse(await run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_2", cwd: "/work", tool_input: { command: "npm test", run_in_background: true } })));
    expect(heavy.hookSpecificOutput.permissionDecisionReason).toBe("lease: run heavy commands in the foreground so the lease can track them");
    expect([names("ui-tests"), names("holders")]).toEqual([[], []]);
  });

  it("denies a backgrounded UI call with the advice that rerunning will not help", async () => {
    const out = JSON.parse(await run(call("PreToolUse", `${UI} &`)));
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("rerunning the same command will not help");
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
    const four = { CO_LEASE_SLOTS: "4" };
    await run(call("PreToolUse", UI, "toolu_1", 600_000), {}, four);
    scripted.alive.add(SESSION);
    const out = await run(call("PreToolUse", UI, "toolu_2"), {}, four);
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    // The UI-test line's own status (capacity 1), not the heavy class's (capacity 4).
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toMatch(/capacity 1[,)]/);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).not.toContain("capacity 4");
    expect(names("ui-tests")).toEqual(["hook-toolu_1.json"]);
    expect(names("holders")).toEqual(["hook-toolu_1.json"]);
    // A UI-test call's wait budget is 400 s, so the hook answers well inside its 500 s timeout (past which Claude Code lets the call through unleased).
    const waited = scripted.clock.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(400_000 - 4_000);
    expect(waited).toBeLessThanOrEqual(400_000);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toContain("no slot after 400s");
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
