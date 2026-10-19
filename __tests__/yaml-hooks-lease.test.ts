import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveHooks } from "../src/yaml-hooks.js";
import * as leaseModule from "../src/lease.js";
import { leaseStatus, tryAcquireLease, type LeaseEvent, type LeaseOptions } from "../src/lease.js";
import type { PressureLevel } from "../src/memory-pressure.js";
import { scriptedPressureSampler } from "../src/testing.js";
import type { Issue } from "../src/types.js";
import type { YamlConfig } from "../src/yaml-types.js";
import { failFsCall, scriptedLease, unwritableLeaseDir, type FakeLeaseClock, type ScriptedLease } from "./helpers/lease.js";

const issue = { number: 7, slug: "foo", ref: "7", wave: 1, dependsOn: [], deps: [], description: "d" } as Issue;

function makeYaml(overrides: Partial<YamlConfig> = {}): YamlConfig {
  return {
    name: "t", configDir: "/tmp/c", worktreeDir: "/tmp/worktrees", projectRoot: "/tmp/p", stallTimeout: 300,
    postSessionCheck: { commands: ["npm test", "npx tsc"] },
    issues: [issue],
    ...overrides,
  };
}

describe("leased postSessionCheck", () => {
  let tmp: string;
  let lease: ScriptedLease;
  let clock: FakeLeaseClock;
  let level: PressureLevel;
  let events: LeaseEvent[];
  let warnings: string[];
  let live: Set<number>;

  const leaseOptions = (overrides: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts(overrides);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "post-check-lease-"));
    level = "normal";
    lease = scriptedLease(tmp, { level: () => level });
    ({ clock, events, warnings, alive: live } = lease);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("takes one slot for the whole check, labelled with the issue, and hands each command the holder env and child PID", async () => {
    const seen: Array<{ holders: string[]; env?: Record<string, string>; onSpawn?: (pid: number) => void }> = [];
    const runCommand = vi.fn(async (_cmd: string, _cwd: string, env?: Record<string, string>, onSpawn?: (pid: number) => void) => {
      seen.push({ holders: leaseStatus(leaseOptions()).live.map((h) => h.command), env, onSpawn });
      onSpawn?.(4242);
      return "";
    });
    live.add(4242);
    const hooks = deriveHooks(makeYaml(), { runCommand });
    const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });

    expect(result).toEqual({ passed: true });
    expect(seen.map((s) => s.holders)).toEqual([["post-check 7"], ["post-check 7"]]);
    const id = (events[0] as Extract<LeaseEvent, { type: "acquire" }>).id;
    expect(seen.map((s) => s.env)).toEqual([{ CO_LEASE_HOLDER: id }, { CO_LEASE_HOLDER: id }]);
    expect(events.map((e) => e.type)).toEqual(["acquire", "release"]);
    expect(leaseStatus(leaseOptions()).live).toEqual([]);
  });

  // The slot covers the whole command loop, so it weighs the largest rule any command matches.
  it.each([
    { name: "records the bytes of the one matching rule", rules: [{ pattern: "^npx tsc", gb: 12 }], expected: 12 * 2 ** 30 },
    { name: "records the largest of several matching rules", rules: [{ pattern: "^npm test", gb: 4 }, { pattern: "^npx tsc", gb: 12 }], expected: 12 * 2 ** 30 },
    { name: "records no weight without a match", rules: [{ pattern: "^make", gb: 12 }], expected: undefined },
  ])("the post-check holder $name", async ({ rules, expected }) => {
    writeFileSync(join(tmp, "w.json"), JSON.stringify(rules));
    vi.stubEnv("CO_LEASE_WEIGHTS_FILE", join(tmp, "w.json"));
    let weight: unknown = "unset";
    const runCommand = vi.fn(async () => {
      weight = leaseStatus(leaseOptions()).live[0]?.weight;
      return "";
    });
    const hooks = deriveHooks(makeYaml(), { runCommand });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });

    expect(weight).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it("reports each child's PID to the holder, so it stays live past a stalled heartbeat", async () => {
    let childPid: number | undefined;
    const runCommand = vi.fn(async (_c: string, _d: string, _e?: Record<string, string>, onSpawn?: (pid: number) => void) => {
      onSpawn?.(process.pid);
      childPid = leaseStatus(leaseOptions()).live[0]?.childPid;
      return "";
    });
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });

    expect(childPid).toBe(process.pid);
  });

  it("releases in finally when a command fails, and stops at the first failure", async () => {
    const runCommand = vi.fn(async () => { throw new Error("boom"); });
    const hooks = deriveHooks(makeYaml(), { runCommand });
    const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });

    expect(result.passed).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["acquire", "release"]);
    expect(leaseStatus(leaseOptions()).live).toEqual([]);
  });

  it("does no lease I/O and calls the runner with exactly (cmd, cwd) without ctx.lease", async () => {
    // Sentinels: any default that resolves the lease directory or $HOME from the environment lands under tmp.
    const sentinel = join(tmp, "never-created");
    vi.stubEnv("CO_LEASE_DIR", sentinel);
    vi.stubEnv("XDG_STATE_HOME", sentinel);
    vi.stubEnv("HOME", sentinel);
    const acquire = vi.spyOn(leaseModule, "acquireLease");
    const tryAcquire = vi.spyOn(leaseModule, "tryAcquireLease");
    const status = vi.spyOn(leaseModule, "leaseStatus");
    const defaults = vi.spyOn(leaseModule, "defaultLeaseOptions");
    const runCommand = vi.fn(async () => "");
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { runningSessions: () => 0 });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo");

    expect(runCommand.mock.calls).toEqual([["npm test", "/tmp/worktrees/foo"], ["npm test", "/tmp/worktrees/foo"]]);
    for (const spy of [acquire, tryAcquire, status, defaults]) expect(spy).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("ignores an inherited holder id: the check takes its own slot instead of riding the inherited one", async () => {
    const parent = tryAcquireLease(leaseOptions(), { command: "parent", cwd: "/" })!;
    parent.setChildPid(process.pid);
    clock.onSleep = () => { if (clock.sleeps.length === 2) parent.release(); };
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand: vi.fn(async () => "") });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions({ inheritedHolderId: parent.id! }) });

    expect(clock.sleeps.length).toBe(2);
  });

  it.each([
    { name: "a check admitted under the per-run override", overridden: true },
    { name: "a check admitted at a real warning", overridden: false },
  ])("records override only for $name", async ({ overridden }) => {
    level = "warning";
    const runCommand = vi.fn(async () => {
      expect(leaseStatus(leaseOptions()).live[0].override).toBe(overridden ? true : undefined);
      return "";
    });
    const sampler = scriptedPressureSampler("warning", { overridden });
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand });
    await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions({ level: sampler }) });

    expect(events[0]).toMatchObject({ type: "acquire", ...(overridden ? { override: true } : {}) });
    expect("override" in events[0]).toBe(overridden);
  });

  it("a full disk stops the check as disk-full: no command runs and the summary names the disk", async () => {
    const restore = failFsCall("openSync", (p) => p.endsWith(".mutex"), "ENOSPC");
    try {
      const runCommand = vi.fn(async () => "");
      const result = await deriveHooks(makeYaml(), { runCommand }).postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });
      expect(runCommand).not.toHaveBeenCalled();
      expect(result).toMatchObject({ passed: false, stopped: "disk-full", summary: expect.stringContaining("disk is full (ENOSPC)") });
    } finally {
      restore();
    }
  });

  describe("at critical", () => {
    it("keeps waiting while an engine session runs, then stops without running any command", async () => {
      level = "critical";
      let running = 2;
      clock.onSleep = () => { running = Math.max(0, running - 1); };
      const runCommand = vi.fn(async () => "");
      const hooks = deriveHooks(makeYaml(), { runCommand });
      const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", {
        lease: leaseOptions(), runningSessions: () => running,
      });

      expect(clock.sleeps.length).toBe(2);
      expect(runCommand).not.toHaveBeenCalled();
      expect(result).toMatchObject({ passed: false, stopped: "memory-critical" });
      expect(result.summary).toBe("post-check: skipped because memory pressure is critical (critical, 0 live); the check did not run and will not be retried");
      expect(result.summary).not.toContain("lease: no slot after");
      expect(result.summary).not.toContain("rerun");
      expect(events).toMatchObject([{ type: "timeout", refused: "stopped", level: "critical" }]);
    });

    it("keeps waiting while a lease holder is live, even with no engine session", async () => {
      const holder = tryAcquireLease(leaseOptions(), { command: "other", cwd: "/" })!;
      holder.setChildPid(process.pid);
      level = "critical";
      clock.onSleep = () => { if (clock.sleeps.length === 3) holder.release(); };
      const runCommand = vi.fn(async () => "");
      const hooks = deriveHooks(makeYaml(), { runCommand });
      const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions(), runningSessions: () => 0 });

      expect(clock.sleeps.length).toBe(3);
      expect(result.stopped).toBe("memory-critical");
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("does not stop on a stale cached reading that a fresh read contradicts", async () => {
      const sampler = scriptedPressureSampler(["critical", "normal"], { fresh: () => "normal" });
      const runCommand = vi.fn(async () => "");
      const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand });
      const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", {
        lease: leaseOptions({ level: sampler }), runningSessions: () => 0,
      });

      expect(result).toEqual({ passed: true });
      expect(runCommand).toHaveBeenCalledTimes(1);
    });

    describe("with sequentialPaths", () => {
      const collidingGit = (peerAdds: boolean) => vi.fn((_f: string, args: string[]) => {
        if (args.includes("fetch")) return "";
        if (args.includes("merge-base") && args.includes("HEAD")) return "abc123\n";
        if (args.includes("/tmp/worktrees/foo") && args.includes("abc123..HEAD")) return "migrations/0056_a.sql\n";
        if (args.includes("/tmp/worktrees/bar") && args.includes("abc123..HEAD")) return peerAdds ? "migrations/0056_b.sql\n" : "\n";
        return "";
      });
      const yaml = () => makeYaml({
        sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        issues: [issue, { number: 8, slug: "bar", dependsOn: [], description: "b" }],
      });

      it("still runs the collision scan; no collision is a stopped result", async () => {
        level = "critical";
        const runCommand = vi.fn(async () => "");
        const runGitCommand = collidingGit(false);
        const hooks = deriveHooks(yaml(), { runCommand, runGitCommand, existsSync: () => true });
        const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions(), runningSessions: () => 0 });

        expect(runCommand).not.toHaveBeenCalled();
        expect(runGitCommand).toHaveBeenCalled();
        expect(result).toMatchObject({ passed: false, stopped: "memory-critical" });
      });

      it("makes a collision an ordinary failed check, not a stopped one", async () => {
        level = "critical";
        const hooks = deriveHooks(yaml(), { runCommand: vi.fn(), runGitCommand: collidingGit(true), existsSync: () => true });
        const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions(), runningSessions: () => 0 });

        expect(result.passed).toBe(false);
        expect(result.stopped).toBeUndefined();
        expect(result.summary).toContain("0056");
      });
    });
  });

  it("runs every command unleased, with no holder env, when the lease directory is unusable at normal pressure", async () => {
    const broken = leaseOptions({ dir: unwritableLeaseDir(tmp) });
    const envs: Array<Record<string, string> | undefined> = [];
    const runCommand = vi.fn(async (_c: string, _d: string, env?: Record<string, string>) => { envs.push(env); return ""; });
    const hooks = deriveHooks(makeYaml(), { runCommand });
    const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: broken });

    expect(result).toEqual({ passed: true });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(envs).toEqual([{}, {}]);
    expect(envs.every((e) => !e || !("CO_LEASE_HOLDER" in e))).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["fail-open"]);
  });

  it("kills the child and releases the holder when onSpawn throws through the default runner", async () => {
    const real = leaseModule.acquireLease;
    let pid: number | undefined;
    vi.spyOn(leaseModule, "acquireLease").mockImplementation(async (...args) => {
      const got = await real(...args);
      if ("refused" in got) return got;
      const setChildPid = got.setChildPid;
      return { ...got, setChildPid: (p: number) => { pid = p; setChildPid(p); throw new Error("onSpawn boom"); } };
    });
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["exec sleep 10"] } }));
    try {
      const result = await hooks.postSessionCheck!(issue, tmp, { lease: leaseOptions() });

      expect(result).toMatchObject({ passed: false });
      expect(result.summary).toContain("onSpawn boom");
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(events.map((e) => e.type)).toEqual(["acquire", "release"]);
      expect(leaseStatus(leaseOptions()).live).toEqual([]);
    } finally {
      if (pid !== undefined && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });

  it("is unaffected by a throwing warning writer while it waits", async () => {
    const full = tryAcquireLease(leaseOptions(), { command: "other", cwd: "/" })!;
    full.setChildPid(process.pid);
    clock.onSleep = () => { if (clock.sleeps.length === 2) full.release(); };
    const runCommand = vi.fn(async () => "");
    const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand });
    const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", {
      lease: leaseOptions({ warn: () => { throw new Error("writer boom"); } }),
    });

    expect(result).toEqual({ passed: true });
    expect(clock.sleeps.length).toBe(2);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  describe("waiting line", () => {
    it("logs at most once a minute, throttled on the lease's waitedMs", async () => {
      const full = tryAcquireLease(leaseOptions(), { command: "other", cwd: "/" })!;
      // The clock passes the 90 s heartbeat window, so the live child PID is what keeps the blocking holder live.
      full.setChildPid(process.pid);
      let elapsed = 0;
      const steps = [0, 20_000, 50_000, 61_000, 70_000, 125_000, 130_000];
      clock.onSleep = () => {
        const i = clock.sleeps.length;
        const target = steps[Math.min(i, steps.length - 1)];
        clock.ms += target - elapsed - clock.sleeps[i - 1]!; // the sleep itself already advanced the clock
        elapsed = target;
        if (i === steps.length - 1) full.release();
      };
      const hooks = deriveHooks(makeYaml({ postSessionCheck: { commands: ["npm test"] } }), { runCommand: vi.fn(async () => "") });
      await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo", { lease: leaseOptions() });

      const lines = warnings.filter((m) => m.startsWith("Issue #7 post-check waiting for a lease slot ("));
      expect(lines).toHaveLength(3);
    });
  });
});
