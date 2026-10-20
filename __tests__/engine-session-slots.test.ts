import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refOf } from "../src/ref.js";
import { Orchestrator } from "../src/engine.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import { acquireSessionLease, leaseStatus, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import type { PressureLevel } from "../src/memory-pressure.js";
import { scriptedHeadroomSampler, scriptedPressureSampler } from "../src/testing.js";
import type { Deps, Issue, OrchestratorConfig, OrchestratorHooks, PostSessionCheckContext, RunOptions, Status } from "../src/types.js";
import { failFsCall, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const makeIssue = (number: number): Issue => {
  const base = { number, slug: `issue-${number}`, wave: 1, dependsOn: [], description: `Issue ${number}` };
  return { ...base, ref: refOf(base), deps: [] };
};

/** What every engine on one machine shares: how many `claude` processes are running at once. */
const newTally = () => ({ running: 0, max: 0, spawned: 0 });

function makeRunner(tally: ReturnType<typeof newTally>, firstPid: number) {
  let nextPid = firstPid;
  const exits = new Map<number, { resolve(code: number): void; reject(e: Error): void }>();
  return {
    exits,
    spawn() {
      const pid = nextPid++;
      tally.running++;
      tally.spawned++;
      tally.max = Math.max(tally.max, tally.running);
      const exitCode = new Promise<number>((resolve, reject) => {
        exits.set(pid, {
          resolve: (code) => (tally.running--, resolve(code)),
          reject: (e) => (tally.running--, reject(e)),
        });
      });
      exitCode.catch(() => {});
      return { pid, issueNumber: 0, exitCode };
    },
    kill() {},
  };
}

const reading = (step: number, level: PressureLevel = "normal"): HeadroomReading => ({ level, step, signals: null });
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe("engine session slots", () => {
  let tmp: string;
  let lease: ScriptedLease;
  let step: number;
  let level: PressureLevel;
  let restore: () => void;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "engine-session-slots-"));
    lease = scriptedLease(join(tmp, "lease"));
    step = 4;
    level = "normal";
    restore = () => {};
  });
  afterEach(() => {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  const leaseOptions = (over: Partial<LeaseOptions> = {}): LeaseOptions =>
    lease.opts({
      headroom: scriptedHeadroomSampler(() => reading(step, level)),
      sessionSlots: 6,
      // The lease's own sleep advances its clock, which would age a held slot past its heartbeat window in a few polls.
      sleep: () => new Promise<void>((r) => setImmediate(r)),
      ...over,
    });

  function engine(
    count: number,
    opts: {
      tally?: ReturnType<typeof newTally>; firstPid?: number; run?: RunOptions; hooks?: Partial<OrchestratorHooks>;
      retries?: number; logSize?: number | ((logFile: string) => number); lease?: Partial<LeaseOptions>; pool?: PressureLevel;
    } = {},
  ) {
    const issues = Array.from({ length: count }, (_, i) => makeIssue(i + 1));
    const hooks: OrchestratorHooks = {
      showHelp: vi.fn(),
      shouldSkipIssue: () => ({ skip: false }),
      isRetryableStatus: () => false,
      preflightCheck: async () => {},
      preRunSetup: async () => {},
      setUpWorktree: async () => {},
      removeWorktree: async () => {},
      getWorktreePath: (i) => `/worktrees/${i.slug}`,
      getBranchName: (i) => `orchestrator/${i.slug}`,
      interpolatePrompt: async (i) => `prompt ${i.number}`,
      getClaudeArgs: () => [],
      printSummary: vi.fn(),
      ...opts.hooks,
    };
    const config: OrchestratorConfig = {
      name: "t", configDir: "/tmp/c", worktreeDir: "/tmp/w", projectRoot: "/tmp/p", stallTimeout: 0, issues, hooks,
    };
    if (opts.retries) config.retryOnCheckFailure = { maxRetries: opts.retries, enabled: true };
    const runner = makeRunner(opts.tally ?? newTally(), opts.firstPid ?? 1000);
    const appended: Array<{ path: string; line: string }> = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() };
    const leaseOpts = leaseOptions(opts.lease);
    const deps: Deps = {
      statusStore: new InMemoryStatusStore(),
      metadataStore: new InMemoryMetadataStore(),
      processRunner: runner,
      logger,
      generateSessionId: () => "sid",
      commandExists: () => true,
      getLogFileSize: (f: string) => (typeof opts.logSize === "function" ? opts.logSize(f) : opts.logSize ?? 100),
      readFile: () => "",
      runCommand: vi.fn((cmd: string) => (cmd.includes("rev-list --count") ? "3" : "")),
      runCommandAsync: vi.fn(async () => ""),
      truncateFile: vi.fn(),
      appendFile: (path, line) => void appended.push({ path, line }),
      memoryPressure: scriptedPressureSampler(() => opts.pool ?? "normal"),
      lease: leaseOpts,
    };
    const orchestrator = new Orchestrator(config, deps, opts.run);
    const status = (n: number): Status => deps.statusStore.get(String(n));
    const live = () => leaseStatus(leaseOpts).sessions!.live.length;
    return { orchestrator, runner, deps, logger, appended, status, live, leaseOpts, meta: (n: number) => deps.metadataStore.get(String(n)) };
  }

  /** Exits the oldest running session of each engine until every wave has settled. */
  async function drain(engines: Array<ReturnType<typeof engine>>, waves: Array<Promise<void>>): Promise<void> {
    let done = 0;
    for (const w of waves) void w.then(() => done++, () => done++);
    for (let i = 0; i < 5_000 && done < waves.length; i++) {
      await tick();
      for (const e of engines) {
        const first = e.runner.exits.entries().next();
        if (!first.done) {
          e.runner.exits.delete(first.value[0]);
          first.value[1].resolve(0);
        }
      }
    }
    expect(done).toBe(waves.length);
  }

  it.each([
    { step: 4, row: 6 },
    { step: 3, row: 4 },
    { step: 2, row: 2 },
    { step: 1, row: 1 },
  ])("never runs more sessions across two engines than the row allows (step $step: $row)", async ({ step: s, row }) => {
    step = s;
    const tally = newTally();
    const a = engine(5, { tally, run: { maxParallel: 5 } });
    const b = engine(5, { tally, firstPid: 2000, run: { maxParallel: 5 } });
    await drain([a, b], [a.orchestrator.runWave(1), b.orchestrator.runWave(1)]);

    expect(tally.spawned).toBe(10);
    expect(tally.max).toBe(row);
    expect(a.live() + b.live()).toBe(0);
  });

  it("holds a slot for exactly as long as the session runs, and none during the post-session check", async () => {
    const duringCheck: number[] = [];
    let e!: ReturnType<typeof engine>;
    e = engine(1, {
      hooks: { postSessionCheck: async () => (duringCheck.push(e.live()), { passed: true }) },
    });
    const wave = e.orchestrator.runWave(1);
    await until(() => e.runner.exits.size === 1, "the spawn");
    expect(e.live()).toBe(1);
    e.runner.exits.get(1000)!.resolve(0);
    await wave;

    expect(duringCheck).toEqual([0]);
    expect(e.live()).toBe(0);
  });

  it("waits for a slot another engine holds, then spawns", async () => {
    const other = (await acquireSessionLease(leaseOptions({ sessionSlots: 1 }), { command: "claude", cwd: "/x" })) as LeaseHandle;
    const e = engine(1, { lease: { sessionSlots: 1 } });
    const wave = e.orchestrator.runWave(1);
    for (let i = 0; i < 50; i++) await tick();
    expect(e.runner.exits.size).toBe(0);
    expect(e.status(1)).toBe("pending");

    other.release();
    await until(() => e.runner.exits.size === 1, "the spawn");
    e.runner.exits.get(1000)!.resolve(0);
    await wave;
    expect(e.status(1)).toBe("succeeded");
  });

  describe("retries", () => {
    it("re-acquires for a 0-byte retry, holding one slot at a time", async () => {
      const e = engine(2, { logSize: 0, lease: { sessionSlots: 1 }, run: { maxParallel: 2 } });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 1, "the first spawn");
      e.runner.exits.get(1000)!.resolve(1);
      await until(() => e.runner.exits.size === 2, "the retry");
      expect(e.live()).toBe(1);
      e.runner.exits.get(1001)!.resolve(0);
      await until(() => e.runner.exits.size === 3, "the second issue");
      expect(e.live()).toBe(1);
      e.runner.exits.get(1002)!.resolve(0);
      await wave;
      expect(e.live()).toBe(0);
    });

    it("re-acquires for a check-failure retry, which waits behind another engine's slot", async () => {
      let checks = 0;
      let openCheck!: () => void;
      const gate = new Promise<void>((r) => (openCheck = r));
      const e = engine(1, {
        retries: 1, lease: { sessionSlots: 1 },
        hooks: { postSessionCheck: async () => (++checks === 1 ? (await gate, { passed: false }) : { passed: true }) },
      });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 1, "the first spawn");
      e.runner.exits.get(1000)!.resolve(0);
      await until(() => checks === 1, "the check");
      expect(e.live()).toBe(0); // the check holds no session slot
      const other = (await acquireSessionLease(leaseOptions({ sessionSlots: 1 }), { command: "claude", cwd: "/x" })) as LeaseHandle;
      openCheck();
      for (let i = 0; i < 50; i++) await tick();
      expect(e.runner.exits.size).toBe(1);

      other.release();
      await until(() => e.runner.exits.size === 2, "the retry");
      expect(e.live()).toBe(1);
      e.runner.exits.get(1001)!.resolve(0);
      await wave;
      expect(e.live()).toBe(0);
    });

    it("releases the slot of a session whose exitCode rejects", async () => {
      const e = engine(1, { lease: { sessionSlots: 1 } });
      const internals = e.orchestrator as unknown as {
        acquireSessionSlot(i: Issue, cwd: string): Promise<LeaseHandle>;
        spawnSession(i: Issue, args: string[], cwd: string, log: string, err: string, o: { slot: LeaseHandle }): unknown;
      };
      const slot = await internals.acquireSessionSlot(makeIssue(1), "/w");
      expect(e.live()).toBe(1);
      internals.spawnSession(makeIssue(1), [], "/w", "/l", "/e", { slot });
      e.runner.exits.get(1000)!.reject(new Error("lost"));
      await until(() => e.live() === 0, "the release");
    });
  });

  describe("--no-adaptive", () => {
    it.each([
      { adaptive: true, step: 1, ran: 1 },
      { adaptive: true, step: 3, ran: 3 },
      { adaptive: false, step: 1, ran: 3 },
      { adaptive: false, step: 3, ran: 3 },
    ])("runs $ran of 3 sessions at once at step $step (adaptive $adaptive, K 3)", async ({ adaptive, step: s, ran }) => {
      step = s;
      const e = engine(3, { run: { maxParallel: 3, adaptive } });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size >= 1, "a spawn");
      for (let i = 0; i < 100; i++) await tick();
      expect(e.runner.exits.size).toBe(ran);
      await drain([e], [wave]);
    });

    it("does not lift the step 1 that CO_PRESSURE_OVERRIDE makes from a real step 0", async () => {
      const headroom = scriptedHeadroomSampler(() => reading(1, "warning"), { overridden: true });
      const e = engine(3, { run: { maxParallel: 3, adaptive: false }, lease: { headroom } });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size >= 1, "a spawn");
      for (let i = 0; i < 100; i++) await tick();
      expect(e.runner.exits.size).toBe(1);
      await drain([e], [wave]);
    });

    it("still closes the session row at step 0", async () => {
      step = 0;
      level = "critical";
      const e = engine(1, { run: { adaptive: false } });
      await e.orchestrator.runWave(1);
      expect(e.runner.exits.size).toBe(0);
    });

    it("leaves the lease it hands the post-check on the shared step", async () => {
      step = 1;
      let seen: number | undefined;
      const e = engine(1, {
        run: { adaptive: false },
        hooks: { postSessionCheck: async (_i: Issue, _w: string, ctx?: PostSessionCheckContext) => ((seen = ctx?.lease?.headroom?.().step), { passed: true }) },
      });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 1, "the spawn");
      e.runner.exits.get(1000)!.resolve(0);
      await wave;
      expect(seen).toBe(1);
    });
  });

  describe("the stop rule on the wait", () => {
    it("stops every unstarted issue as memory-critical, pending, when the wait meets a confirmed critical with nothing running", async () => {
      step = 0;
      level = "critical";
      const e = engine(2, { run: { maxParallel: 2 } });
      await e.orchestrator.runWave(1);

      expect(e.runner.exits.size).toBe(0);
      for (const n of [1, 2]) {
        expect(e.status(n)).toBe("pending");
        expect(e.meta(n)).toMatchObject({ failureReason: "memory-critical", stopStage: "launch" });
      }
    });

    it("does not stop while another engine's session is live", async () => {
      const other = (await acquireSessionLease(leaseOptions(), { command: "claude", cwd: "/x" })) as LeaseHandle;
      step = 0;
      level = "critical";
      const e = engine(1);
      const wave = e.orchestrator.runWave(1);
      for (let i = 0; i < 50; i++) await tick();
      expect(e.status(1)).toBe("pending");
      expect(e.meta(1).failureReason).toBeUndefined();

      step = 4;
      level = "normal";
      await until(() => e.runner.exits.size === 1, "the spawn");
      other.release();
      e.runner.exits.get(1000)!.resolve(0);
      await wave;
    });

    it("stops a retry as memory-critical, failed, when critical arrives while it waits", async () => {
      const e = engine(1, { logSize: 0 });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 1, "the spawn");
      step = 0;
      level = "critical";
      e.runner.exits.get(1000)!.resolve(1);
      await wave;

      expect(e.runner.exits.size).toBe(1);
      expect(e.status(1)).toBe("failed");
      expect(e.meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "retry" });
    });

    it("stops a full disk as disk-full, pending at launch, and spawns nothing", async () => {
      restore = failFsCall("writeFileSync", (p) => p.includes("/sessions/"), "ENOSPC");
      const e = engine(2, { run: { maxParallel: 2 } });
      await e.orchestrator.runWave(1);

      expect(e.runner.exits.size).toBe(0);
      for (const n of [1, 2]) {
        expect(e.status(n)).toBe("pending");
        expect(e.meta(n)).toMatchObject({ failureReason: "disk-full", stopStage: "launch" });
      }
    });
  });

  describe("per-engine capacity", () => {
    it.each(["normal", "warning"] as const)("is K at %s", async (pool) => {
      const e = engine(3, { run: { maxParallel: 3 }, pool });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 3, "all three spawns");
      await drain([e], [wave]);
    });

    it("re-checks the pool after a session wait, so a launch never runs past a limit that dropped meanwhile", async () => {
      let openCheck!: () => void;
      const gate = new Promise<void>((r) => (openCheck = r));
      const e = engine(4, {
        run: { maxParallel: 3 }, lease: { sessionSlots: 3 },
        logSize: (f) => (f.endsWith("/issue-1.log") ? 0 : 100),
        hooks: { postSessionCheck: async (i: Issue) => (i.number === 2 && await gate, { passed: true }) },
      });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.runner.exits.size === 3, "issues 1 to 3");
      e.runner.exits.get(1001)!.resolve(0); // issue 2 exits; its pipeline keeps its pool slot through the check
      await until(() => e.live() === 2, "issue 2's session slot to free");
      const other = (await acquireSessionLease(leaseOptions({ sessionSlots: 3 }), { command: "claude", cwd: "/x" })) as LeaseHandle;
      e.runner.exits.get(1000)!.resolve(1); // issue 1's 0-byte exit; its retry takes the freed slot
      await until(() => e.runner.exits.size === 4, "issue 1's retry");
      openCheck(); // the pool frees a slot and issue 4 waits for a session slot
      for (let i = 0; i < 50; i++) await tick();
      e.runner.exits.get(1003)!.resolve(1); // the retry fails 0-byte too: the pool falls back to 1 and its session slot frees
      for (let i = 0; i < 100; i++) await tick();
      expect(e.runner.exits.size).toBe(4); // issue 3 still runs, so issue 4 must not start

      other.release();
      e.runner.exits.get(1002)!.resolve(0);
      await until(() => e.runner.exits.size === 5, "issue 4");
      e.runner.exits.get(1004)!.resolve(0);
      await wave;
      expect(e.live()).toBe(0);
    });

    it("releases the session slot when the launch throws before the spawn", async () => {
      const e = engine(1);
      e.deps.metadataStore.update = (_ref, fields) => {
        if ("startedAt" in fields) throw new Error("store write failed");
      };
      await expect(e.orchestrator.runWave(1)).rejects.toThrow("store write failed");
      expect(e.runner.exits.size).toBe(0);
      expect(e.live()).toBe(0);
    });
  });

  describe("the wait's progress line", () => {
    it("writes to issue-<ref>.wait.log on the first poll and then once a minute of waiting", async () => {
      const other = (await acquireSessionLease(leaseOptions({ sessionSlots: 1 }), { command: "claude", cwd: "/x" })) as LeaseHandle;
      const e = engine(1, { lease: { sessionSlots: 1 } });
      const wave = e.orchestrator.runWave(1);
      await until(() => e.appended.length >= 1, "the first line");
      expect(e.appended).toHaveLength(1);
      expect(e.appended[0]!.path).toBe("/tmp/c/logs/issue-1.wait.log");
      expect(e.appended[0]!.line).toMatch(/waiting for a session slot/);

      lease.clock.ms += 65_000;
      await until(() => e.appended.length === 2, "the second line");
      lease.clock.ms += 20_000;
      for (let i = 0; i < 20; i++) await tick();
      expect(e.appended).toHaveLength(2);

      other.release();
      await until(() => e.runner.exits.size === 1, "the spawn");
      e.runner.exits.get(1000)!.resolve(0);
      await wave;
    });
  });
});
