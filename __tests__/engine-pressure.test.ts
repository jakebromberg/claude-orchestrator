import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { refOf } from "../src/ref.js";
import { Orchestrator } from "../src/engine.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import type {
  Issue, OrchestratorConfig, OrchestratorHooks, RunOptions, Deps, PostCheckResult, Status,
} from "../src/types.js";
import type { PressureLevel, PressureSampler } from "../src/memory-pressure.js";

function makeIssue(number: number, wave = 1): Issue {
  const base = { number, slug: `issue-${number}`, wave, dependsOn: [], description: `Issue ${number}` };
  return { ...base, ref: refOf(base), deps: [] };
}

/** A sampler whose cached reading (`sample`) and fresh reading can differ, to model a stale cache. */
function makeSampler(level: PressureLevel) {
  const ctl = { level, freshLevel: undefined as PressureLevel | undefined, freshCalls: 0 };
  const sampler = Object.assign(() => ctl.level, {
    fresh: () => {
      ctl.freshCalls++;
      return ctl.freshLevel ?? ctl.level;
    },
  }) as PressureSampler;
  return { ctl, sampler };
}

function makeRunner() {
  let nextPid = 1000;
  const resolvers = new Map<number, (code: number) => void>();
  const spawned: string[][] = [];
  return {
    spawned,
    resolvers,
    spawn(_c: string, args: string[]) {
      const pid = nextPid++;
      spawned.push(args);
      const exitCode = new Promise<number>((r) => resolvers.set(pid, r));
      return { pid, issueNumber: 0, exitCode };
    },
    kill() {},
  };
}

function setUp(
  issueCount: number,
  level: PressureLevel,
  opts: {
    run?: RunOptions; hooks?: Partial<OrchestratorHooks>; retries?: number; logSize?: number; waves?: number[];
    shape?: (issues: Issue[]) => void;
  } = {},
) {
  const issues = Array.from({ length: issueCount }, (_, i) => makeIssue(i + 1, opts.waves?.[i]));
  opts.shape?.(issues);
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
  const { ctl, sampler } = makeSampler(level);
  const runner = makeRunner();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() };
  const deps: Deps = {
    statusStore: new InMemoryStatusStore(),
    metadataStore: new InMemoryMetadataStore(),
    processRunner: runner,
    logger,
    generateSessionId: () => "sid",
    commandExists: () => true,
    getLogFileSize: () => opts.logSize ?? 100,
    readFile: () => "",
    runCommand: vi.fn((cmd: string) => (cmd.includes("rev-list --count") ? "3" : "")),
    truncateFile: vi.fn(),
    memoryPressure: sampler,
  };
  const orchestrator = new Orchestrator(config, deps, opts.run);
  const status = (n: number): Status => deps.statusStore.get(String(n));
  return { orchestrator, deps, runner, ctl, logger, status, meta: (n: number) => deps.metadataStore.get(String(n)) };
}

describe("pressure-aware launches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("launches one at a time at warning", async () => {
    const { orchestrator, runner } = setUp(3, "warning", { run: { maxParallel: 3 } });
    const wave = orchestrator.runWave(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(1);

    runner.resolvers.get(1000)!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(2);

    runner.resolvers.get(1001)!(0);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1002)!(0);
    await wave;
  });

  it("returns to full capacity only after normal has held for 60 s", async () => {
    const { orchestrator, runner, ctl } = setUp(3, "warning", { run: { maxParallel: 3 } });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(1);

    ctl.level = "normal";
    await vi.advanceTimersByTimeAsync(10_000); // calm starts
    await vi.advanceTimersByTimeAsync(40_000);
    expect(runner.spawned.length).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.spawned.length).toBe(3);

    for (const pid of [1000, 1001, 1002]) runner.resolvers.get(pid)!(0);
    await wave;
  });

  it("with --no-adaptive ignores warning", async () => {
    const { orchestrator, runner } = setUp(3, "warning", { run: { maxParallel: 3, adaptive: false } });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(3);
    for (const pid of [1000, 1001, 1002]) runner.resolvers.get(pid)!(0);
    await wave;
  });

  it("clears its timer when the wave ends", async () => {
    const { orchestrator, runner } = setUp(1, "normal");
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1000)!(0);
    await wave;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ adaptive: true }, { adaptive: false }])(
    "starts nothing at critical and marks every unstarted issue stopped (%o)",
    async ({ adaptive }) => {
      const { orchestrator, runner, status, meta, logger } = setUp(2, "critical", { run: { adaptive } });
      await orchestrator.runWave(1);

      expect(runner.spawned.length).toBe(0);
      for (const n of [1, 2]) {
        expect(status(n)).toBe("pending");
        expect(meta(n)).toMatchObject({ failureReason: "memory-critical", stopStage: "launch" });
      }
      const stopLines = logger.warn.mock.calls.filter(([m]) => String(m).includes("memory-critical"));
      expect(stopLines).toHaveLength(1);
    },
  );

  it.each([{ adaptive: true }, { adaptive: false }])(
    "lets running sessions finish, starts nothing however long critical lasts, then stops once none is active (%o)",
    async ({ adaptive }) => {
      const { orchestrator, runner, ctl, status, meta } = setUp(2, "normal", { run: { maxParallel: 1, adaptive } });
      const wave = orchestrator.runWave(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.spawned.length).toBe(1);

      // The launcher is blocked at critical behind a running session: no timer may turn this wait into a start.
      ctl.level = "critical";
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(runner.spawned.length).toBe(1);
      expect(status(2)).toBe("pending");
      expect(meta(2).failureReason).toBeUndefined();

      runner.resolvers.get(1000)!(0);
      await wave;

      expect(status(1)).toBe("succeeded");
      expect(runner.spawned.length).toBe(1);
      expect(meta(2)).toMatchObject({ failureReason: "memory-critical", stopStage: "launch" });
    },
  );

  it("holds the process open while a launch waits on the pressure tick, and the tick still applies the stop", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { orchestrator, runner, ctl, status, meta } = setUp(2, "critical", { run: { maxParallel: 1 } });
    ctl.freshLevel = "normal"; // a stale cached critical: capacity 0, but no stop
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(0);

    // Nothing is running, so the tick is the only thing that can wake this launcher.
    // Unref'd, it would let Node exit mid-wave with no report and the issues unmarked.
    const tick = intervals.mock.results[0].value as NodeJS.Timeout;
    expect(tick.hasRef()).toBe(true);
    intervals.mockRestore();

    ctl.freshLevel = undefined; // a fresh reading now agrees: critical
    await vi.advanceTimersByTimeAsync(10_000);
    await wave;

    expect(runner.spawned.length).toBe(0);
    for (const n of [1, 2]) {
      expect(status(n)).toBe("pending");
      expect(meta(n)).toMatchObject({ failureReason: "memory-critical", stopStage: "launch" });
    }
  });

  it("keeps the 60 s hysteresis across a wave boundary", async () => {
    const { orchestrator, runner, ctl } = setUp(4, "warning", { run: { maxParallel: 3 }, waves: [1, 2, 2, 2] });
    const run = orchestrator.runAllWaves();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(1);

    ctl.level = "normal";
    runner.resolvers.get(1000)!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(2); // wave 2 still launches one at a time

    await vi.advanceTimersByTimeAsync(70_000);
    expect(runner.spawned.length).toBe(4);

    for (const pid of [1001, 1002, 1003]) runner.resolvers.get(pid)!(0);
    await run;
  });

  it("keeps the 0-byte fallback's limit of 1 through a return to normal", async () => {
    const { orchestrator, runner, ctl } = setUp(3, "normal", { run: { maxParallel: 2 }, logSize: 0 });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(2);

    runner.resolvers.get(1000)!(1); // 0-byte failure: retried once
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1002)!(1); // still 0-byte: fall back to one session at a time
    await vi.advanceTimersByTimeAsync(0);

    ctl.level = "warning";
    await vi.advanceTimersByTimeAsync(10_000);
    ctl.level = "normal";
    await vi.advanceTimersByTimeAsync(70_000); // capacity is back to 2
    expect(runner.spawned.length).toBe(3); // issue 3 still waits for issue 2

    runner.resolvers.get(1001)!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(4);
    runner.resolvers.get(1003)!(0);
    await wave;
  });

  it("does not let one stale critical sample end the wave: a fresh reading confirms", async () => {
    const { orchestrator, runner, ctl } = setUp(2, "critical", { run: { maxParallel: 1 } });
    ctl.freshLevel = "normal";
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.freshCalls).toBeGreaterThan(0);
    // The cached critical closes capacity, but nothing is active and fresh says normal: keep waiting.
    expect(runner.spawned.length).toBe(0);

    ctl.level = "normal";
    await vi.advanceTimersByTimeAsync(70_000);
    expect(runner.spawned.length).toBe(1);
    runner.resolvers.get(1000)!(0);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1001)!(0);
    await wave;
  });

  it("clears a stale stop marker when the issue launches", async () => {
    const { orchestrator, runner, deps, meta } = setUp(1, "normal");
    deps.metadataStore.update("1", { failureReason: "memory-critical", stopStage: "launch" });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(meta(1).failureReason).toBeUndefined();
    expect(meta(1).stopStage).toBeUndefined();
    runner.resolvers.get(1000)!(0);
    await wave;
  });

  const STOP = { failureReason: "memory-critical", stopStage: "launch" } as const;

  it.each<{
    name: string;
    opts: Parameters<typeof setUp>[2];
    run: (o: Orchestrator) => Promise<void>;
    ends: Status;
    held?: boolean;
  }>([
    {
      name: "skipped for a failed dependency",
      opts: { shape: (issues) => { issues[0].dependsOn = [2]; issues[0].deps = ["2"]; } },
      run: (o) => o.runSpecific([1]),
      ends: "skipped",
    },
    {
      name: "failed in worktree set-up",
      opts: { hooks: { setUpWorktree: async () => { throw new Error("no worktree"); } } },
      run: (o) => o.runWave(1),
      ends: "failed",
    },
    {
      name: "skipped by the wrapper's shouldSkipIssue",
      opts: { hooks: { shouldSkipIssue: () => ({ skip: true }) } },
      run: (o) => o.runSpecific([1]),
      ends: "succeeded",
    },
    {
      name: "held at a cutover gate",
      opts: {
        shape: (issues) => {
          issues[0].mode = "gate";
          Object.assign(issues[1], { mode: "deploy", command: "true" }); // nothing else for the run to launch
        },
      },
      run: (o) => o.runAllWaves(),
      ends: "pending",
      held: true,
    },
  ])("clears a stale stop marker on an issue that ends $name", async ({ opts, run, ends, held }) => {
    const { orchestrator, deps, status, meta, logger } = setUp(2, "normal", opts);
    deps.statusStore.set("2", "failed");
    deps.metadataStore.update("1", STOP);
    await run(orchestrator);

    expect(status(1)).toBe(ends);
    expect(meta(1).failureReason).toBeUndefined();
    expect(meta(1).stopStage).toBeUndefined();
    if (held) {
      // Only runAllWaves reports held gates, so only the held row can assert it.
      const heldLines = logger.warn.mock.calls.filter(([m]) => String(m).includes("held at a cutover gate"));
      expect(heldLines.some(([m]) => String(m).includes("Held: 1"))).toBe(true);
    }
  });

  it("leaves the metadata of an already-succeeded issue unchanged", async () => {
    const { orchestrator, deps, meta } = setUp(1, "normal");
    deps.statusStore.set("1", "succeeded");
    deps.metadataStore.update("1", STOP);
    await orchestrator.runWave(1);
    expect(meta(1)).toMatchObject(STOP);
  });

  it("does not report a stopped issue as held at a cutover gate", async () => {
    const { orchestrator, logger } = setUp(1, "critical");
    await orchestrator.runAllWaves();
    expect(logger.warn.mock.calls.some(([m]) => String(m).includes("cutover gate"))).toBe(false);
  });
});

describe("pressure-aware retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const failingCheck = (): Partial<OrchestratorHooks> => ({
    postSessionCheck: vi.fn(async () => ({ passed: false, output: "lint", summary: "lint" })),
  });

  it("refuses a check-failure retry at critical", async () => {
    const { orchestrator, runner, ctl, status, meta } = setUp(1, "normal", { hooks: failingCheck(), retries: 2 });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    ctl.level = "critical";
    runner.resolvers.get(1000)!(0);
    await wave;

    expect(runner.spawned.length).toBe(1);
    expect(status(1)).toBe("failed");
    expect(meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "retry" });
  });

  it("clears a marker the failed check left behind once the retry session has run", async () => {
    const { orchestrator, runner, deps, status, meta } = setUp(1, "normal", {
      hooks: {
        postSessionCheck: vi.fn(async () => {
          deps.metadataStore.update("1", { failureReason: "memory-critical", stopStage: "post-check" });
          return { passed: false, output: "lint", summary: "lint" };
        }),
      },
      retries: 1,
    });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1000)!(0);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1001)!(1); // the retry itself fails, so no later check can clear the marker
    await wave;

    expect(status(1)).toBe("failed");
    expect(meta(1).failureReason).toBeUndefined();
    expect(meta(1).stopStage).toBeUndefined();
  });

  it("clears a stale marker before the check runs", async () => {
    const seen: unknown[] = [];
    const { orchestrator, runner, deps, meta } = setUp(1, "normal", {
      hooks: {
        postSessionCheck: vi.fn(async () => {
          seen.push({ ...deps.metadataStore.get("1") });
          deps.metadataStore.update("1", { failureReason: "memory-critical", stopStage: "post-check" });
          return { passed: false, output: "lint", summary: "lint" };
        }),
      },
    });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    deps.metadataStore.update("1", { failureReason: "memory-critical", stopStage: "launch" }); // left by the session
    runner.resolvers.get(1000)!(0);
    await wave;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ failureReason: undefined, stopStage: undefined });
    expect(meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "post-check" }); // the hook's own, written after the clear
  });

  it("still retries at warning", async () => {
    const { orchestrator, runner, ctl, status } = setUp(1, "normal", { hooks: failingCheck(), retries: 1 });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    ctl.level = "warning";
    runner.resolvers.get(1000)!(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.spawned.length).toBe(2);
    runner.resolvers.get(1001)!(0);
    await wave;
    expect(status(1)).toBe("failed"); // the check keeps failing; the retry itself ran
  });

  it("refuses the 0-byte retry at critical", async () => {
    const { orchestrator, runner, ctl, status, meta } = setUp(1, "normal", { logSize: 0 });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    ctl.level = "critical";
    runner.resolvers.get(1000)!(1);
    await wave;

    expect(runner.spawned.length).toBe(1);
    expect(status(1)).toBe("failed");
    expect(meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "retry" });
  });

  it("clears a marker left during the first attempt once the 0-byte retry has run", async () => {
    const { orchestrator, runner, deps, status, meta } = setUp(1, "normal", { logSize: 0 });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    deps.metadataStore.update("1", { failureReason: "memory-critical", stopStage: "launch" }); // left by the first attempt
    runner.resolvers.get(1000)!(1); // 0-byte failure: retried once
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1001)!(1); // the retry fails too, so nothing later can clear the marker
    await wave;

    expect(runner.spawned.length).toBe(2);
    expect(status(1)).toBe("failed");
    expect(meta(1).failureReason).toBeUndefined();
    expect(meta(1).stopStage).toBeUndefined();
  });

  it.each([1, 2])(
    "never retries a check that did not run for memory pressure after a retry (maxRetries %i)",
    async (retries) => {
      const results: PostCheckResult[] = [
        { passed: false, output: "lint", summary: "lint" },
        { passed: false, stopped: "memory-critical" },
      ];
      const { orchestrator, runner, status, meta } = setUp(1, "normal", {
        hooks: { postSessionCheck: vi.fn(async () => results.shift()!) },
        retries,
      });
      const wave = orchestrator.runWave(1);
      await vi.advanceTimersByTimeAsync(0);
      runner.resolvers.get(1000)!(0);
      await vi.advanceTimersByTimeAsync(0);
      runner.resolvers.get(1001)!(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.spawned.length).toBe(2);
      for (const resolve of runner.resolvers.values()) resolve(0);
      await wave;
      expect(status(1)).toBe("failed");
      expect(meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "post-check" });
    },
  );

  it("never retries a check that did not run for memory pressure", async () => {
    const stopped: PostCheckResult = { passed: false, stopped: "memory-critical" };
    const { orchestrator, runner, status, meta } = setUp(1, "normal", {
      hooks: { postSessionCheck: vi.fn(async () => stopped) },
      retries: 2,
    });
    const wave = orchestrator.runWave(1);
    await vi.advanceTimersByTimeAsync(0);
    runner.resolvers.get(1000)!(0);
    await wave;

    expect(runner.spawned.length).toBe(1);
    expect(status(1)).toBe("failed");
    expect(meta(1)).toMatchObject({ failureReason: "memory-critical", stopStage: "post-check" });
  });
});
