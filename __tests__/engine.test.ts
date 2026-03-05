import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Orchestrator, cleanUpMergedIssues } from "../src/engine.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import type {
  Issue,
  OrchestratorConfig,
  OrchestratorHooks,
  RunOptions,
  Deps,
  ProcessHandle,
  ProcessRunner,
  Status,
  Logger,
} from "../src/types.js";
import type { MergeResult } from "../src/merge.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    slug: "test-issue",
    wave: 1,
    deps: [],
    dependsOn: [],
    description: "Test issue",
    ...overrides,
  };
}

function makeHooks(overrides: Partial<OrchestratorHooks> = {}): OrchestratorHooks {
  return {
    showHelp: vi.fn(),
    shouldSkipIssue: vi.fn(() => ({ skip: false })),
    isRetryableStatus: vi.fn(
      (s: Status) => s === "failed" || s === "interrupted" || s === "running",
    ),
    preflightCheck: vi.fn(async () => {}),
    preRunSetup: vi.fn(async () => {}),
    setUpWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    getWorktreePath: vi.fn((issue: Issue) => `/worktrees/${issue.slug}`),
    getBranchName: vi.fn((issue: Issue) => `orchestrator/${issue.slug}`),
    interpolatePrompt: vi.fn(async (issue: Issue) => `prompt for #${issue.number}`),
    getClaudeArgs: vi.fn(() => ["--add-dir", "/extra"]),
    printSummary: vi.fn(),
    ...overrides,
  };
}

function makeMockRunner(): ProcessRunner & {
  spawned: Array<{ command: string; args: string[]; cwd: string; logFile: string; stderrFile?: string }>;
  resolvers: Map<number, (code: number) => void>;
} {
  let nextPid = 1000;
  const resolvers = new Map<number, (code: number) => void>();
  const spawned: Array<{ command: string; args: string[]; cwd: string; logFile: string; stderrFile?: string }> = [];

  return {
    spawned,
    resolvers,
    spawn(command, args, options) {
      const pid = nextPid++;
      spawned.push({ command, args, cwd: options.cwd, logFile: options.logFile, stderrFile: options.stderrFile });
      let resolve!: (code: number) => void;
      const exitCode = new Promise<number>((r) => {
        resolve = r;
      });
      resolvers.set(pid, resolve);
      return { pid, issueNumber: 0, exitCode };
    },
    kill(pid: number) {
      const resolve = resolvers.get(pid);
      if (resolve) resolve(137);
    },
  };
}

function makeSilentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    header: vi.fn(),
  };
}

function makeConfig(
  issues: Issue[],
  hooks?: Partial<OrchestratorHooks>,
): OrchestratorConfig {
  return {
    name: "Test Orchestrator",
    configDir: "/tmp/test-config",
    worktreeDir: "/tmp/test-worktrees",
    projectRoot: "/tmp/test-project",
    stallTimeout: 0,
    issues,
    hooks: makeHooks(hooks),
  };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    statusStore: new InMemoryStatusStore(),
    metadataStore: new InMemoryMetadataStore(),
    processRunner: makeMockRunner(),
    logger: makeSilentLogger(),
    generateSessionId: () => "test-session-id",
    commandExists: () => true,
    getLogFileSize: () => 100,
    readFile: () => "",
    runCommand: vi.fn(() => ""),
    truncateFile: vi.fn(),
    ...overrides,
  };
}

function makeOrchestrator(
  issues: Issue[],
  hooks?: Partial<OrchestratorHooks>,
  depsOverrides?: Partial<Deps>,
  runOptions?: RunOptions,
) {
  const config = makeConfig(issues, hooks);
  const deps = makeDeps(depsOverrides);
  const orchestrator = new Orchestrator(config, deps, runOptions);
  return { orchestrator, config, deps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  describe("dependency resolution", () => {
    it("proceeds for issue with no deps", async () => {
      const issue = makeIssue({ number: 1, deps: [] });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      // Let microtasks flush before resolving
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
    });

    it("proceeds when all deps succeeded", async () => {
      const dep = makeIssue({ number: 1, deps: [] });
      const issue = makeIssue({ number: 2, deps: [1], wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([dep, issue]);

      deps.statusStore.set(1, "succeeded");

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(2)).toBe("succeeded");
    });

    it("skips issue when dep failed", async () => {
      // dep is in wave 0 so it's not part of wave 1 execution
      const dep = makeIssue({ number: 1, deps: [], wave: 0 });
      const issue = makeIssue({ number: 2, deps: [1], wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([dep, issue]);

      deps.statusStore.set(1, "failed");

      await orchestrator.runWave(1);

      expect(deps.statusStore.get(2)).toBe("skipped");
    });

    it("skips issue when dep is pending", async () => {
      const dep = makeIssue({ number: 1, deps: [], wave: 0 });
      const issue = makeIssue({ number: 2, deps: [1], wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([dep, issue]);

      // dep stays pending (default)
      await orchestrator.runWave(1);

      expect(deps.statusStore.get(2)).toBe("skipped");
    });

    it("skips issue when dep does not exist in config", async () => {
      const issue = makeIssue({ number: 2, deps: [999], wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      await orchestrator.runWave(1);

      expect(deps.statusStore.get(2)).toBe("skipped");
    });
  });

  describe("wave execution", () => {
    it("filters to wave-1 issues only", async () => {
      const w1 = makeIssue({ number: 1, wave: 1 });
      const w2 = makeIssue({ number: 2, wave: 2 });
      const { orchestrator, deps } = makeOrchestrator([w1, w2]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(deps.statusStore.get(2)).toBe("pending");
    });

    it("skips already-succeeded issues", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      deps.statusStore.set(1, "succeeded");
      await orchestrator.runWave(1);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      expect(runner.spawned.length).toBe(0);
    });

    it("prepares issues sequentially (order preserved)", async () => {
      const order: number[] = [];
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 1 }),
      ];

      const hooks = makeHooks({
        setUpWorktree: vi.fn(async (issue: Issue) => {
          order.push(issue.number);
        }),
      });

      const config = makeConfig(issues);
      config.hooks = hooks;
      const deps = makeDeps();
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // Wait for all spawns
      await vi.waitFor(() => expect(runner.spawned.length).toBe(3));

      // Resolve all
      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;

      expect(order).toEqual([1, 2, 3]);
    });

    it("launches issues in parallel", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
      ];
      const { orchestrator, deps } = makeOrchestrator(issues);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // Both should be spawned before either resolves
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;
    });
  });

  describe("all-waves mode", () => {
    it("discovers and sorts waves numerically", async () => {
      const wavesRun: number[] = [];
      const issues = [
        makeIssue({ number: 1, wave: 2 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 3 }),
      ];

      const { deps } = makeOrchestrator(issues);
      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;

      // Spy on runWave by observing which issues get spawned in order
      const config = makeConfig(issues);
      const orchestrator = new Orchestrator(config, deps);

      const promise = orchestrator.runAllWaves();

      // Wave 1: issue #2
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);

      // Wave 2: issue #1
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      runner.resolvers.get(1001)!(0);

      // Wave 3: issue #3
      await vi.waitFor(() => expect(runner.spawned.length).toBe(3));
      runner.resolvers.get(1002)!(0);

      await promise;

      // Verify order: wave 1 issue (issue #2), wave 2 (issue #1), wave 3 (issue #3)
      expect(deps.statusStore.get(2)).toBe("succeeded"); // wave 1
      expect(deps.statusStore.get(1)).toBe("succeeded"); // wave 2
      expect(deps.statusStore.get(3)).toBe("succeeded"); // wave 3
    });
  });

  describe("specific issues", () => {
    it("runs only specified issues", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 1 }),
      ];
      const { orchestrator, deps } = makeOrchestrator(issues);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runSpecific([1, 3]);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(deps.statusStore.get(2)).toBe("pending");
      expect(deps.statusStore.get(3)).toBe("succeeded");
    });

    it("logs error for unknown issue", async () => {
      const { orchestrator, deps } = makeOrchestrator([
        makeIssue({ number: 1, wave: 1 }),
      ]);

      await orchestrator.runSpecific([999]);

      expect((deps.logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining("999"),
      );
    });

    it("skips already-succeeded issue", async () => {
      const { orchestrator, deps } = makeOrchestrator([
        makeIssue({ number: 1, wave: 1 }),
      ]);

      deps.statusStore.set(1, "succeeded");
      await orchestrator.runSpecific([1]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      expect(runner.spawned.length).toBe(0);
    });
  });

  describe("retry", () => {
    it("retries failed, interrupted, and running statuses by default", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 1 }),
        makeIssue({ number: 4, wave: 1 }),
      ];
      const { orchestrator, deps } = makeOrchestrator(issues);

      deps.statusStore.set(1, "failed");
      deps.statusStore.set(2, "interrupted");
      deps.statusStore.set(3, "succeeded");
      deps.statusStore.set(4, "running");

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.retryFailed();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(3));

      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(deps.statusStore.get(2)).toBe("succeeded");
      expect(deps.statusStore.get(3)).toBe("succeeded"); // unchanged
      expect(deps.statusStore.get(4)).toBe("succeeded");
    });

    it("resets retryable issues to pending before preparing", async () => {
      const issues = [makeIssue({ number: 1, wave: 1 })];
      const { orchestrator, deps } = makeOrchestrator(issues);

      deps.statusStore.set(1, "failed");

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.retryFailed();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Before the process completes, status should have been reset to pending then running
      expect(deps.statusStore.get(1)).toBe("running");

      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;
    });

    it("logs message when no retryable issues", async () => {
      const { orchestrator, deps } = makeOrchestrator([
        makeIssue({ number: 1, wave: 1 }),
      ]);
      deps.statusStore.set(1, "succeeded");

      await orchestrator.retryFailed();

      expect((deps.logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining("No retryable issues"),
      );
    });
  });

  describe("shouldSkipIssue hook", () => {
    it("skips issue when hook returns skip: true", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue], {
        shouldSkipIssue: () => ({ skip: true, reason: "manual" }),
      });

      await orchestrator.runWave(1);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      expect(runner.spawned.length).toBe(0);
    });

    it("proceeds when hook returns skip: false", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue], {
        shouldSkipIssue: () => ({ skip: false }),
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
    });
  });

  describe("issue preparation", () => {
    it("sets status to failed when worktree setup fails", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue], {
        setUpWorktree: vi.fn(async () => {
          throw new Error("git error");
        }),
      });

      await orchestrator.runWave(1);

      expect(deps.statusStore.get(1)).toBe("failed");
      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      expect(runner.spawned.length).toBe(0);
    });
  });

  describe("issue execution", () => {
    it("sets status to running before launch", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      expect(deps.statusStore.get(1)).toBe("running");

      runner.resolvers.get(1000)!(0);
      await promise;
    });

    it("sets status to succeeded on exit code 0", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
    });

    it("sets status to failed on non-zero exit", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(1);
      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
    });

    it("calls getClaudeArgs hook for extra args", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getClaudeArgs = vi.fn(() => ["--add-dir", "/foo"]);
      const { orchestrator, deps } = makeOrchestrator([issue], { getClaudeArgs });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      expect(getClaudeArgs).toHaveBeenCalledWith(issue);
      expect(runner.spawned[0].args).toContain("--add-dir");
      expect(runner.spawned[0].args).toContain("/foo");

      runner.resolvers.get(1000)!(0);
      await promise;
    });

    it("passes stderrFile path to spawn", async () => {
      const issue = makeIssue({ number: 42, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      expect(runner.spawned[0].stderrFile).toBe(
        "/tmp/test-config/logs/issue-42.stderr.log",
      );

      runner.resolvers.get(1000)!(0);
      await promise;
    });

    it("passes logFile path to spawn", async () => {
      const issue = makeIssue({ number: 7, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      expect(runner.spawned[0].logFile).toBe(
        "/tmp/test-config/logs/issue-7.log",
      );

      runner.resolvers.get(1000)!(0);
      await promise;
    });
  });

  describe("cleanup", () => {
    it("calls removeWorktree for each issue", async () => {
      const issues = [
        makeIssue({ number: 1 }),
        makeIssue({ number: 2 }),
      ];
      const removeWorktree = vi.fn(async () => {});
      const { orchestrator } = makeOrchestrator(issues, { removeWorktree });

      await orchestrator.cleanup();

      expect(removeWorktree).toHaveBeenCalledTimes(2);
      expect(removeWorktree).toHaveBeenCalledWith(issues[0]);
      expect(removeWorktree).toHaveBeenCalledWith(issues[1]);
    });
  });

  describe("signal handling", () => {
    it("marks running issues as interrupted", async () => {
      const issues = [
        makeIssue({ number: 1 }),
        makeIssue({ number: 2 }),
        makeIssue({ number: 3 }),
      ];
      const { orchestrator, deps } = makeOrchestrator(issues);

      deps.statusStore.set(1, "running");
      deps.statusStore.set(2, "succeeded");
      deps.statusStore.set(3, "running");

      await orchestrator.handleInterrupt();

      expect(deps.statusStore.get(1)).toBe("interrupted");
      expect(deps.statusStore.get(2)).toBe("succeeded");
      expect(deps.statusStore.get(3)).toBe("interrupted");
    });

    it("calls printSummary on interrupt", async () => {
      const issues = [makeIssue({ number: 1 })];
      const printSummary = vi.fn();
      const { orchestrator } = makeOrchestrator(issues, { printSummary });

      await orchestrator.handleInterrupt();

      expect(printSummary).toHaveBeenCalled();
    });
  });

  describe("stale status reset", () => {
    it("resets running statuses to pending on startup", async () => {
      const issues = [
        makeIssue({ number: 1 }),
        makeIssue({ number: 2 }),
        makeIssue({ number: 3 }),
      ];
      const { orchestrator, deps } = makeOrchestrator(issues);

      deps.statusStore.set(1, "running");
      deps.statusStore.set(2, "succeeded");
      deps.statusStore.set(3, "failed");

      await orchestrator.resetStaleStatuses();

      expect(deps.statusStore.get(1)).toBe("pending");
      expect(deps.statusStore.get(2)).toBe("succeeded");
      expect(deps.statusStore.get(3)).toBe("failed");
    });
  });

  describe("allowedTools configuration", () => {
    it("uses config.allowedTools when provided", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const config = makeConfig([issue]);
      config.allowedTools = ["Bash", "Read", "Skill"];
      const deps = makeDeps();
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      const toolsArgIndex = runner.spawned[0].args.indexOf("--allowedTools");
      expect(toolsArgIndex).toBeGreaterThan(-1);
      expect(runner.spawned[0].args[toolsArgIndex + 1]).toBe("Bash,Read,Skill");

      runner.resolvers.get(1000)!(0);
      await promise;
    });

    it("falls back to default tools when config.allowedTools is not set", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      const toolsArgIndex = runner.spawned[0].args.indexOf("--allowedTools");
      expect(toolsArgIndex).toBeGreaterThan(-1);
      expect(runner.spawned[0].args[toolsArgIndex + 1]).toBe(
        "Bash,Read,Write,Edit,Glob,Grep,WebFetch,Task",
      );

      runner.resolvers.get(1000)!(0);
      await promise;
    });
  });

  describe("maxParallel configuration", () => {
    it("respects maxParallel from constructor options", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 1 }),
      ];
      const config = makeConfig(issues);
      const deps = makeDeps();
      const orchestrator = new Orchestrator(config, deps, { maxParallel: 1 });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // With maxParallel=1, only one should be spawned initially
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Second should not be spawned yet
      await new Promise((r) => setTimeout(r, 50));
      expect(runner.spawned.length).toBe(1);

      // Complete first, then second should spawn
      runner.resolvers.get(1000)!(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      runner.resolvers.get(1001)!(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(3));

      runner.resolvers.get(1002)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(deps.statusStore.get(2)).toBe("succeeded");
      expect(deps.statusStore.get(3)).toBe("succeeded");
    });

    it("defaults to 4 when maxParallel not specified", async () => {
      const issues = Array.from({ length: 5 }, (_, i) =>
        makeIssue({ number: i + 1, wave: 1, slug: `issue-${i + 1}` }),
      );
      const config = makeConfig(issues);
      const deps = makeDeps();
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // 4 should spawn immediately, 5th should wait
      await vi.waitFor(() => expect(runner.spawned.length).toBe(4));
      await new Promise((r) => setTimeout(r, 50));
      expect(runner.spawned.length).toBe(4);

      // Complete one, 5th should spawn
      runner.resolvers.get(1000)!(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(5));

      for (const [, resolve] of runner.resolvers) resolve(0);
      await promise;
    });
  });

  describe("prerequisites", () => {
    it("throws when claude CLI is missing", () => {
      const { orchestrator } = makeOrchestrator([], undefined, {
        commandExists: (cmd: string) => cmd !== "claude",
      });

      expect(() => orchestrator.checkPrerequisites()).toThrow("claude");
    });

    it("throws when gh CLI is missing", () => {
      const { orchestrator } = makeOrchestrator([], undefined, {
        commandExists: (cmd: string) => cmd !== "gh",
      });

      expect(() => orchestrator.checkPrerequisites()).toThrow("gh");
    });

    it("does not throw when both are available", () => {
      const { orchestrator } = makeOrchestrator([], undefined, {
        commandExists: () => true,
      });

      expect(() => orchestrator.checkPrerequisites()).not.toThrow();
    });
  });

  describe("stall monitor", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not create monitor when stallTimeout is 0", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const config = makeConfig([issue]);
      config.stallTimeout = 0;
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Advance well past any check interval — getLogFileSize should never be called
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getLogFileSize).not.toHaveBeenCalled();

      runner.resolvers.get(1000)!(0);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("creates and starts monitor when stallTimeout > 0", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 100);
      const config = makeConfig([issue]);
      config.stallTimeout = 30;
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Advance past the check interval (10s) so the monitor calls getLogSize
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getLogFileSize).toHaveBeenCalled();

      runner.resolvers.get(1000)!(0);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("stops monitor when process exits normally", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      // Return constant size — would trigger stall if monitor kept running
      const getLogFileSize = vi.fn(() => 50);
      const config = makeConfig([issue]);
      config.stallTimeout = 30;
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Let a few checks run
      await vi.advanceTimersByTimeAsync(10_000);

      // Process exits normally — this should stop the monitor
      runner.resolvers.get(1000)!(0);
      await vi.advanceTimersByTimeAsync(0);

      // Now advance well past stall timeout — kill should NOT be called
      const killSpy = vi.spyOn(deps.processRunner, "kill");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(killSpy).not.toHaveBeenCalled();

      await promise;
    });

    it("kills process when stall is detected", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      // Return constant size to simulate no log output
      const getLogFileSize = vi.fn(() => 50);
      const config = makeConfig([issue]);
      config.stallTimeout = 30;
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const killSpy = vi.spyOn(deps.processRunner, "kill");
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Advance past stallTimeout (30s) in check-interval increments
      // First check at 10s records initial size, then 20s and 30s accumulate stall time
      await vi.advanceTimersByTimeAsync(40_000);

      expect(killSpy).toHaveBeenCalledWith(1000);

      // kill resolves exit code 137, let it settle
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("sets status to failed when process is killed due to stall", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 50);
      const config = makeConfig([issue]);
      config.stallTimeout = 30;
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Advance past stallTimeout to trigger kill
      await vi.advanceTimersByTimeAsync(40_000);

      // Let the exit code promise settle
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
    });

    it("uses issue stallTimeout when provided, overriding config", async () => {
      const issue = makeIssue({ number: 1, wave: 1, stallTimeout: 60 });
      const getLogFileSize = vi.fn(() => 50);
      const config = makeConfig([issue]);
      config.stallTimeout = 30; // global is 30s, but issue overrides to 60s
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const killSpy = vi.spyOn(deps.processRunner, "kill");
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // At 40s: past config timeout (30s) but before issue timeout (60s)
      await vi.advanceTimersByTimeAsync(40_000);
      expect(killSpy).not.toHaveBeenCalled();

      // At 70s: past issue timeout (60s) — should be killed
      await vi.advanceTimersByTimeAsync(30_000);
      expect(killSpy).toHaveBeenCalledWith(1000);

      // Verify warning message uses issue-level timeout (60s)
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("60s"),
      );

      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("issue stallTimeout of 0 disables monitoring even when config has timeout", async () => {
      const issue = makeIssue({ number: 1, wave: 1, stallTimeout: 0 });
      const getLogFileSize = vi.fn(() => 50);
      const config = makeConfig([issue]);
      config.stallTimeout = 30; // global is 30s, but issue disables with 0
      const deps = makeDeps({ getLogFileSize });
      const orchestrator = new Orchestrator(config, deps);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // Advance well past config timeout — getLogFileSize should never be called
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getLogFileSize).not.toHaveBeenCalled();

      runner.resolvers.get(1000)!(0);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });
  });

  describe("postSessionCheck hook", () => {
    it("marks succeeded when hook is absent (backward compat)", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
    });

    it("marks succeeded when hook passes", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const postSessionCheck = vi.fn(async () => ({ passed: true }));
      const { orchestrator, deps } = makeOrchestrator([issue], { postSessionCheck });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(postSessionCheck).toHaveBeenCalledWith(issue, `/worktrees/${issue.slug}`);
      expect(deps.statusStore.get(1)).toBe("succeeded");
    });

    it("marks failed when hook fails", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const postSessionCheck = vi.fn(async () => ({
        passed: false,
        summary: "tests failed",
      }));
      const { orchestrator, deps } = makeOrchestrator([issue], { postSessionCheck });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      expect(deps.logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.stringContaining("tests failed"),
      );
    });

    it("marks failed when hook throws", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const postSessionCheck = vi.fn(async () => {
        throw new Error("check crashed");
      });
      const { orchestrator, deps } = makeOrchestrator([issue], { postSessionCheck });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      expect(deps.logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.stringContaining("check crashed"),
      );
    });

    it("does not call hook on non-zero exit", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const postSessionCheck = vi.fn(async () => ({ passed: true }));
      const { orchestrator, deps } = makeOrchestrator([issue], { postSessionCheck });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(1);
      await promise;

      expect(postSessionCheck).not.toHaveBeenCalled();
      expect(deps.statusStore.get(1)).toBe("failed");
    });

    it("completes all post-checks before launchAndWait returns", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1, slug: "issue-1" }),
        makeIssue({ number: 2, wave: 1, slug: "issue-2" }),
      ];
      let checkCount = 0;
      const postSessionCheck = vi.fn(async () => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        checkCount++;
        return { passed: true };
      });
      const { orchestrator, deps } = makeOrchestrator(issues, { postSessionCheck });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      runner.resolvers.get(1000)!(0);
      runner.resolvers.get(1001)!(0);
      await promise;

      expect(checkCount).toBe(2);
      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(deps.statusStore.get(2)).toBe("succeeded");
    });
  });

  describe("PR tracking metadata", () => {
    it("extracts PR URL from log and stores in metadata", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() =>
        "Created PR: https://github.com/org/repo/pull/42\nDone.",
      );
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(meta.prNumber).toBe(42);
    });

    it("records metadata even when no PR URL found", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() => "Session completed with no PR.");
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBeUndefined();
      expect(meta.exitCode).toBe(0);
      expect(meta.finishedAt).toBeDefined();
    });

    it("records exit code and timestamps in metadata", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(1);
      await promise;

      const meta = deps.metadataStore.get(1);
      expect(meta.exitCode).toBe(1);
      expect(meta.startedAt).toBeDefined();
      expect(meta.finishedAt).toBeDefined();
    });

    it("extracts PR URL even on failed exit", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() =>
        "Created PR: https://github.com/org/repo/pull/99\nThen failed.",
      );
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(1);
      await promise;

      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBe("https://github.com/org/repo/pull/99");
      expect(deps.statusStore.get(1)).toBe("failed");
    });

    it("handles readFile throwing gracefully", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() => {
        throw new Error("ENOENT");
      });
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBeUndefined();
    });
  });

  describe("auto-retry on 0-byte stall", () => {
    it("retries once on 0-byte log + non-zero exit and succeeds", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const truncateFile = vi.fn();
      const { orchestrator, deps } = makeOrchestrator(
        [issue], undefined, { getLogFileSize, truncateFile },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // First spawn exits with non-zero code
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);

      // Retry spawn should appear
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      // Retry succeeds: make log non-empty for PR extraction
      getLogFileSize.mockReturnValue(100);
      runner.resolvers.get(1001)!(0);

      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(truncateFile).toHaveBeenCalled();
      expect((deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join(" "))
        .toContain("after retry");
    });

    it("does not retry on non-zero exit with log content", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 1000);
      const { orchestrator, deps } = makeOrchestrator(
        [issue], undefined, { getLogFileSize },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);
      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      expect(runner.spawned.length).toBe(1);
    });

    it("does not retry on success", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const { orchestrator, deps } = makeOrchestrator([issue]);

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);
      await promise;

      expect(deps.statusStore.get(1)).toBe("succeeded");
      expect(runner.spawned.length).toBe(1);
    });

    it("marks failed if retry also fails", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const { orchestrator, deps } = makeOrchestrator(
        [issue], undefined, { getLogFileSize },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // First spawn: 0-byte exit 1
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);

      // Retry spawn: also exit 1
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      runner.resolvers.get(1001)!(1);

      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      // Only 2 spawns total (one retry, not infinite)
      expect(runner.spawned.length).toBe(2);
    });

    it("runs postSessionCheck after successful retry", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const postSessionCheck = vi.fn(async () => ({ passed: true }));
      const { orchestrator, deps } = makeOrchestrator(
        [issue],
        { postSessionCheck },
        { getLogFileSize },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // First spawn: 0-byte exit 1
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);

      // Retry spawn: exits 0
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      getLogFileSize.mockReturnValue(100);
      runner.resolvers.get(1001)!(0);

      await promise;

      expect(postSessionCheck).toHaveBeenCalledTimes(1);
      expect(deps.statusStore.get(1)).toBe("succeeded");
    });

    it("logs stderr contents before retry", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const readFile = vi.fn((path: string) =>
        path.endsWith(".stderr.log") ? "error: something went wrong" : "",
      );
      const { orchestrator, deps } = makeOrchestrator(
        [issue], undefined, { getLogFileSize, readFile },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      getLogFileSize.mockReturnValue(100);
      runner.resolvers.get(1001)!(0);

      await promise;

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((msg: string) => msg.includes("error: something went wrong"))).toBe(true);
    });

    it("truncates both log and stderr files before retry", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const getLogFileSize = vi.fn(() => 0);
      const truncateFile = vi.fn();
      const { orchestrator, deps } = makeOrchestrator(
        [issue], undefined, { getLogFileSize, truncateFile },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      getLogFileSize.mockReturnValue(100);
      runner.resolvers.get(1001)!(0);

      await promise;

      const truncatedPaths = truncateFile.mock.calls.map((c: string[]) => c[0]);
      expect(truncatedPaths).toContainEqual(expect.stringContaining("issue-1.log"));
      expect(truncatedPaths).toContainEqual(expect.stringContaining("issue-1.stderr.log"));
    });

    it("starts fresh stall monitor for retry", async () => {
      vi.useFakeTimers();
      try {
        const issue = makeIssue({ number: 1, wave: 1 });
        const getLogFileSize = vi.fn(() => 0);
        const config = makeConfig([issue]);
        config.stallTimeout = 30;
        const deps = makeDeps({ getLogFileSize });
        const orchestrator = new Orchestrator(config, deps);

        const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
        const promise = orchestrator.runWave(1);

        // First spawn: 0-byte + non-zero exit
        await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
        runner.resolvers.get(1000)!(1);

        // Retry spawn appears
        await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

        // Advance past stall timeout — retry should be killed
        for (let i = 0; i < 4; i++) {
          vi.advanceTimersByTime(10_000);
          await vi.advanceTimersByTimeAsync(0);
        }

        await promise;

        // Retry was killed by stall monitor (exit code 137 from kill)
        expect(deps.statusStore.get(1)).toBe("failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("sequential fallback on 0-byte retry failure", () => {
    it("reduces parallelism to 1 after 0-byte retry failure", async () => {
      // 5 issues, maxParallel=2. Issues 1+2 spawn in parallel.
      // Issue 1: 0-byte on both original and retry -> triggers fallback.
      // When issue 1 original exits, pool frees a slot and issue 3 spawns.
      // The retry runs inside the postCheck (not tracked by pool).
      // After fallback triggers, issues 4 and 5 should run one at a time.
      const issues = [
        makeIssue({ number: 1, wave: 1, slug: "a" }),
        makeIssue({ number: 2, wave: 1, slug: "b" }),
        makeIssue({ number: 3, wave: 1, slug: "c" }),
        makeIssue({ number: 4, wave: 1, slug: "d" }),
        makeIssue({ number: 5, wave: 1, slug: "e" }),
      ];
      const getLogFileSize = vi.fn((path: string) =>
        path.includes("issue-1") ? 0 : 100,
      );
      const { orchestrator, deps } = makeOrchestrator(
        issues, undefined, { getLogFileSize }, { maxParallel: 2 },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // Issues 1 (pid=1000) and 2 (pid=1001) spawn in parallel
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      // Issue 1 original: 0-byte, exit 1
      // This triggers: postCheck (spawns retry pid=1002), then pool frees
      // slot -> issue 3 spawns (pid=1003).
      runner.resolvers.get(1000)!(1);

      // Retry (pid=1002) and issue 3 (pid=1003) spawn
      await vi.waitFor(() => expect(runner.spawned.length).toBe(4));

      // Issue 1 retry: still 0-byte, exit 1 -> triggers setMaxParallel(1)
      runner.resolvers.get(1002)!(1);

      // Issue 2 completes successfully
      runner.resolvers.get(1001)!(0);

      // Issue 3 completes successfully — pool now has 0 active
      runner.resolvers.get(1003)!(0);

      // Issue 4 (pid=1004) should spawn (maxParallel=1, 0 active -> has slot)
      await vi.waitFor(() => expect(runner.spawned.length).toBe(5));

      // Issue 5 should NOT have spawned yet (maxParallel=1, issue 4 running)
      expect(runner.spawned.length).toBe(5);

      // Complete issue 4
      runner.resolvers.get(1004)!(0);

      // Now issue 5 (pid=1005) should spawn
      await vi.waitFor(() => expect(runner.spawned.length).toBe(6));
      runner.resolvers.get(1005)!(0);

      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      expect(deps.statusStore.get(2)).toBe("succeeded");
      expect(deps.statusStore.get(3)).toBe("succeeded");
      expect(deps.statusStore.get(4)).toBe("succeeded");
      expect(deps.statusStore.get(5)).toBe("succeeded");
    });

    it("does not reduce parallelism for non-0-byte retry failure", async () => {
      // Issue 1 retries (original 0-byte), retry fails with log content.
      // Fallback should NOT trigger because the retry log has content.
      const issues = [
        makeIssue({ number: 1, wave: 1, slug: "a" }),
        makeIssue({ number: 2, wave: 1, slug: "b" }),
      ];
      let issue1RetryDone = false;
      const getLogFileSize = vi.fn((path: string) => {
        if (path.includes("issue-1")) {
          // 0-byte on original, non-zero on retry
          return issue1RetryDone ? 500 : 0;
        }
        return 100;
      });
      const { orchestrator, deps } = makeOrchestrator(
        issues, undefined, { getLogFileSize }, { maxParallel: 2 },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // Issues 1 and 2 spawn in parallel
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      // Issue 1 original: 0-byte, exit 1
      runner.resolvers.get(1000)!(1);

      // Issue 1 retry spawns (pool slot freed, but the for-loop already
      // spawned both issues so no new issue spawns here)
      await vi.waitFor(() => expect(runner.spawned.length).toBe(3));

      // Retry produces log content but still fails
      issue1RetryDone = true;
      runner.resolvers.get(1002)!(1);

      // Issue 2 completes
      runner.resolvers.get(1001)!(0);

      await promise;

      expect(deps.statusStore.get(1)).toBe("failed");
      expect(deps.statusStore.get(2)).toBe("succeeded");

      // No fallback warning logged
      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((msg: string) =>
        msg.includes("falling back to sequential"),
      )).toBe(false);
    });

    it("logs fallback warning at most once", async () => {
      // Two issues both fail with 0-byte on original and retry.
      const issues = [
        makeIssue({ number: 1, wave: 1, slug: "a" }),
        makeIssue({ number: 2, wave: 1, slug: "b" }),
      ];
      const getLogFileSize = vi.fn(() => 0);
      const { orchestrator, deps } = makeOrchestrator(
        issues, undefined, { getLogFileSize }, { maxParallel: 2 },
      );

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);

      // Both issues spawn in parallel
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));

      // Both originals fail with 0-byte
      runner.resolvers.get(1000)!(1);
      runner.resolvers.get(1001)!(1);

      // Both retries spawn
      await vi.waitFor(() => expect(runner.spawned.length).toBe(4));

      // Both retries fail with 0-byte
      runner.resolvers.get(1002)!(1);
      runner.resolvers.get(1003)!(1);

      await promise;

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      const fallbackWarnings = warnCalls.filter((msg: string) =>
        msg.includes("falling back to sequential"),
      );
      expect(fallbackWarnings.length).toBe(1);
    });
  });

  describe("metadata refresh on re-run", () => {
    it("refreshes PR metadata from log file for succeeded issues", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() =>
        "Created PR: https://github.com/org/repo/pull/55\nDone.",
      );
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      // Mark as succeeded with stale metadata
      deps.statusStore.set(1, "succeeded");
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });

      await orchestrator.runWave(1);

      // Metadata should be refreshed from the log
      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBe("https://github.com/org/repo/pull/55");
      expect(meta.prNumber).toBe(55);
    });

    it("handles missing log file gracefully", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      deps.statusStore.set(1, "succeeded");
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });

      // Should not throw
      await orchestrator.runWave(1);

      // Metadata should be unchanged
      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBe("https://github.com/org/repo/pull/10");
      expect(meta.prNumber).toBe(10);
    });

    it("does not clear metadata when log has no PR URL", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() => "Session completed with no PR URL.");
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      deps.statusStore.set(1, "succeeded");
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });

      await orchestrator.runWave(1);

      // Existing metadata should be preserved
      const meta = deps.metadataStore.get(1);
      expect(meta.prUrl).toBe("https://github.com/org/repo/pull/10");
      expect(meta.prNumber).toBe(10);
    });

    it("does not refresh metadata for non-succeeded issues", async () => {
      const issue = makeIssue({ number: 1, wave: 1 });
      const readFile = vi.fn(() =>
        "PR: https://github.com/org/repo/pull/99",
      );
      const { orchestrator, deps } = makeOrchestrator([issue], undefined, { readFile });

      // Issue is pending (default) — it will go through normal launch flow
      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runWave(1);
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

      // After spawning but before exit, readFile should NOT have been called
      // (refreshMetadata only runs for succeeded issues, and post-session
      // extraction only runs after process exit)
      expect(readFile).not.toHaveBeenCalled();

      runner.resolvers.get(1000)!(0);
      await promise;
    });
  });

  describe("merge-after-wave policy", () => {
    it("does not merge when policy is none", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 2 }),
      ];
      const readFile = vi.fn(() =>
        "https://github.com/org/repo/pull/10",
      );
      const runCommand = vi.fn(() => "");
      const config = makeConfig(issues);
      const deps = makeDeps({ readFile, runCommand });
      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "none",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);

      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      runner.resolvers.get(1001)!(0);

      await promise;

      expect(runCommand).not.toHaveBeenCalled();
    });

    it("merges after each wave when policy is after-wave", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 2 }),
      ];
      const readFile = vi.fn(() =>
        "PR: https://github.com/org/repo/pull/10",
      );
      const runCommand = vi.fn(() => "");
      const config = makeConfig(issues);
      const deps = makeDeps({ readFile, runCommand });
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });
      deps.metadataStore.set(2, {
        prUrl: "https://github.com/org/repo/pull/11",
        prNumber: 11,
      });

      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "after-wave",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      // Wave 1
      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);

      // Wave 2
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      runner.resolvers.get(1001)!(0);

      await promise;

      // Should have called merge + cleanup for both waves (2 merges + 2 branch deletions)
      expect(runCommand).toHaveBeenCalledWith(
        expect.stringContaining("gh pr merge"),
      );
      expect(runCommand).toHaveBeenCalledWith(
        expect.stringContaining("git push origin --delete"),
      );
      // 2 merges + 2 branch deletions = 4 total
      expect(runCommand).toHaveBeenCalledTimes(4);
    });

    it("skips merge for failed issues in wave", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
      ];
      const readFile = vi.fn(() => "no PR here");
      const runCommand = vi.fn(() => "");
      const config = makeConfig(issues);
      const deps = makeDeps({ readFile, runCommand });
      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "after-wave",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1); // fail

      await promise;

      // No merge command should be called (issue failed, no PR metadata)
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("passes getWorktreePath through to mergePrs for intra-wave rebase", async () => {
      const issues = [
        makeIssue({ number: 1, slug: "issue-1", wave: 1 }),
        makeIssue({ number: 2, slug: "issue-2", wave: 1 }),
      ];
      const readFile = vi.fn(() =>
        "PR: https://github.com/org/repo/pull/10",
      );
      const commands: string[] = [];
      const runCommand = vi.fn((cmd: string) => {
        commands.push(cmd);
        return "";
      });
      const config = makeConfig(issues);
      const deps = makeDeps({ readFile, runCommand });
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });
      deps.metadataStore.set(2, {
        prUrl: "https://github.com/org/repo/pull/11",
        prNumber: 11,
      });

      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "after-wave",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      // Both issues succeed in the same wave
      await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
      runner.resolvers.get(1000)!(0);
      runner.resolvers.get(1001)!(0);

      await promise;

      // After merging #1, should rebase #2's worktree before merging it
      const rebaseCommands = commands.filter((c) => c.includes("rebase origin/main"));
      expect(rebaseCommands.length).toBeGreaterThanOrEqual(1);
      expect(rebaseCommands[0]).toContain("/worktrees/issue-2");
    });

    it("cleans up worktrees and remote branches after merging", async () => {
      const issues = [
        makeIssue({ number: 1, slug: "my-feature", wave: 1 }),
      ];
      const readFile = vi.fn(() =>
        "PR: https://github.com/org/repo/pull/10",
      );
      const commands: string[] = [];
      const runCommand = vi.fn((cmd: string) => {
        commands.push(cmd);
        return "";
      });
      const hooks = makeHooks();
      const config = makeConfig(issues, hooks);
      const deps = makeDeps({ readFile, runCommand });
      deps.metadataStore.set(1, {
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
      });

      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "after-wave",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(0);

      await promise;

      // Worktree removed
      expect(hooks.removeWorktree).toHaveBeenCalledWith(issues[0]);
      // Remote branch deleted
      expect(runCommand).toHaveBeenCalledWith(
        "git push origin --delete orchestrator/my-feature",
      );
    });

    it("does not clean up worktrees for non-merged issues", async () => {
      const issues = [
        makeIssue({ number: 1, slug: "failing-issue", wave: 1 }),
      ];
      const readFile = vi.fn(() => "no PR here");
      const runCommand = vi.fn(() => "");
      const hooks = makeHooks();
      const config = makeConfig(issues, hooks);
      const deps = makeDeps({ readFile, runCommand });
      const orchestrator = new Orchestrator(config, deps, {
        mergePolicy: "after-wave",
      });

      const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
      const promise = orchestrator.runAllWaves();

      await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
      runner.resolvers.get(1000)!(1); // fail

      await promise;

      // No cleanup — issue failed, no merge happened
      expect(hooks.removeWorktree).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// cleanUpMergedIssues (standalone function)
// ---------------------------------------------------------------------------

describe("cleanUpMergedIssues", () => {
  it("removes worktree for merged issues", async () => {
    const issue = makeIssue({ number: 1, slug: "my-feature" });
    const mergeResults = new Map<number, MergeResult>([[1, "merged"]]);
    const removeWorktree = vi.fn(async () => {});
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues([issue], mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    expect(removeWorktree).toHaveBeenCalledWith(issue);
  });

  it("deletes remote branch for merged issues", async () => {
    const issue = makeIssue({ number: 1, slug: "my-feature" });
    const mergeResults = new Map<number, MergeResult>([[1, "merged"]]);
    const removeWorktree = vi.fn(async () => {});
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues([issue], mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    expect(runCommand).toHaveBeenCalledWith(
      "git push origin --delete orchestrator/my-feature",
    );
  });

  it("uses getBranchName to determine the branch", async () => {
    const issue = makeIssue({ number: 1, slug: "my-feature" });
    const mergeResults = new Map<number, MergeResult>([[1, "merged"]]);
    const removeWorktree = vi.fn(async () => {});
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `epic/${i.slug}`);

    await cleanUpMergedIssues([issue], mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    expect(runCommand).toHaveBeenCalledWith(
      "git push origin --delete epic/my-feature",
    );
  });

  it("skips non-merged issues", async () => {
    const issues = [
      makeIssue({ number: 1, slug: "failed-one" }),
      makeIssue({ number: 2, slug: "skipped-one" }),
      makeIssue({ number: 3, slug: "rebase-failed" }),
    ];
    const mergeResults = new Map<number, MergeResult>([
      [1, "failed"],
      [2, "skipped"],
      [3, "rebase-failed"],
    ]);
    const removeWorktree = vi.fn(async () => {});
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues(issues, mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    expect(removeWorktree).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("handles worktree removal failure gracefully", async () => {
    const issue = makeIssue({ number: 1, slug: "my-feature" });
    const mergeResults = new Map<number, MergeResult>([[1, "merged"]]);
    const removeWorktree = vi.fn(async () => {
      throw new Error("worktree locked");
    });
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues([issue], mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    // Warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("worktree removal failed"),
    );
    // Remote branch deletion still attempted
    expect(runCommand).toHaveBeenCalledWith(
      "git push origin --delete orchestrator/my-feature",
    );
  });

  it("handles remote branch deletion failure gracefully", async () => {
    const issues = [
      makeIssue({ number: 1, slug: "first" }),
      makeIssue({ number: 2, slug: "second" }),
    ];
    const mergeResults = new Map<number, MergeResult>([
      [1, "merged"],
      [2, "merged"],
    ]);
    const removeWorktree = vi.fn(async () => {});
    const runCommand = vi.fn((cmd: string) => {
      if (cmd.includes("--delete")) throw new Error("branch not found");
      return "";
    });
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues(issues, mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    // Warning logged for both
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Worktree removal still called for both issues
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });

  it("cleans up multiple merged issues even when first fails", async () => {
    const issues = [
      makeIssue({ number: 1, slug: "first" }),
      makeIssue({ number: 2, slug: "second" }),
    ];
    const mergeResults = new Map<number, MergeResult>([
      [1, "merged"],
      [2, "merged"],
    ]);
    const removeWorktree = vi.fn(async (issue: Issue) => {
      if (issue.number === 1) throw new Error("locked");
    });
    const runCommand = vi.fn(() => "");
    const logger = makeSilentLogger();
    const getBranchName = vi.fn((i: Issue) => `orchestrator/${i.slug}`);

    await cleanUpMergedIssues(issues, mergeResults, {
      removeWorktree,
      runCommand,
      logger,
      getBranchName,
    });

    // Both issues attempted
    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledTimes(2);
    // Second issue's branch deletion still happened
    expect(runCommand).toHaveBeenCalledWith(
      "git push origin --delete orchestrator/second",
    );
  });
});

describe("upstream context in prepareIssues", () => {
  it("passes UPSTREAM_CONTEXT extraVars when dependency has HANDOFF.md", async () => {
    const dep = makeIssue({ number: 1, slug: "dep-task", wave: 1, deps: [] });
    const issue = makeIssue({ number: 2, slug: "main-task", wave: 2, deps: [1] });

    const interpolatePrompt = vi.fn(async (_issue: Issue, _extraVars?: Record<string, string>) =>
      `prompt for #${_issue.number}`,
    );

    const { orchestrator, deps } = makeOrchestrator([dep, issue], {
      interpolatePrompt,
    }, {
      readFile: vi.fn((p: string) => {
        if (p.includes("HANDOFF.md")) return "Handoff content from dep";
        return "";
      }),
    });

    deps.statusStore.set(1, "succeeded");

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(2);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

    // Verify interpolatePrompt was called with extraVars containing UPSTREAM_CONTEXT
    expect(interpolatePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ number: 2 }),
      expect.objectContaining({ UPSTREAM_CONTEXT: expect.stringContaining("Handoff content from dep") }),
    );

    runner.resolvers.get(1000)!(0);
    await promise;
  });

  it("does not pass UPSTREAM_CONTEXT when no HANDOFF.md exists", async () => {
    const dep = makeIssue({ number: 1, slug: "dep-task", wave: 1, deps: [] });
    const issue = makeIssue({ number: 2, slug: "main-task", wave: 2, deps: [1] });

    const interpolatePrompt = vi.fn(async (_issue: Issue) =>
      `prompt for #${_issue.number}`,
    );

    const { orchestrator, deps } = makeOrchestrator([dep, issue], {
      interpolatePrompt,
    }, {
      readFile: vi.fn(() => { throw new Error("ENOENT"); }),
    });

    deps.statusStore.set(1, "succeeded");

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(2);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

    // Should be called without extraVars (undefined)
    expect(interpolatePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ number: 2 }),
      undefined,
    );

    runner.resolvers.get(1000)!(0);
    await promise;
  });
});

describe("onStatusChange hook", () => {
  it("is called with correct old and new statuses on transition", async () => {
    const onStatusChange = vi.fn(async () => {});
    const issue = makeIssue({ number: 1, wave: 1 });
    const { orchestrator, deps } = makeOrchestrator([issue], { onStatusChange });

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

    // Should have been called with pending -> running
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      "pending",
      "running",
    );

    runner.resolvers.get(1000)!(0);
    await promise;

    // Should have been called with running -> succeeded
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      "running",
      "succeeded",
    );
  });

  it("does not prevent status change when hook throws", async () => {
    const onStatusChange = vi.fn(async () => { throw new Error("hook error"); });
    const issue = makeIssue({ number: 1, wave: 1 });
    const { orchestrator, deps } = makeOrchestrator([issue], { onStatusChange });

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));

    expect(deps.statusStore.get(1)).toBe("running");

    runner.resolvers.get(1000)!(0);
    await promise;

    // Status should still change despite hook error
    expect(deps.statusStore.get(1)).toBe("succeeded");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("onStatusChange hook error"),
    );
  });
});

describe("CI failure retry", () => {
  it("retries when postSessionCheck fails and retryOnCheckFailure is enabled", async () => {
    let checkCallCount = 0;
    const issue = makeIssue({ number: 1, wave: 1 });
    const config = makeConfig([issue], {
      postSessionCheck: vi.fn(async () => {
        checkCallCount++;
        if (checkCallCount === 1) {
          return { passed: false, output: "test failed: assertion error", summary: "Tests failed" };
        }
        return { passed: true };
      }),
    });
    config.retryOnCheckFailure = { maxRetries: 2, enabled: true };
    const deps = makeDeps();
    const orchestrator = new Orchestrator(config, deps);

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);

    // First spawn (original)
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
    runner.resolvers.get(1000)!(0);

    // Retry spawn
    await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
    runner.resolvers.get(1001)!(0);

    await promise;

    expect(deps.statusStore.get(1)).toBe("succeeded");
    expect(deps.metadataStore.get(1).retryCount).toBe(1);

    // Retry prompt should contain failure context
    const retryArgs = runner.spawned[1].args;
    const promptIndex = retryArgs.indexOf("-p");
    expect(retryArgs[promptIndex + 1]).toContain("CI Failure Context");
    expect(retryArgs[promptIndex + 1]).toContain("test failed: assertion error");
  });

  it("marks as failed when all retries exhausted", async () => {
    const issue = makeIssue({ number: 1, wave: 1 });
    const config = makeConfig([issue], {
      postSessionCheck: vi.fn(async () => ({
        passed: false, output: "lint errors", summary: "Lint failed",
      })),
    });
    config.retryOnCheckFailure = { maxRetries: 1, enabled: true };
    const deps = makeDeps();
    const orchestrator = new Orchestrator(config, deps);

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);

    // Original spawn
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
    runner.resolvers.get(1000)!(0);

    // Retry spawn
    await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
    runner.resolvers.get(1001)!(0);

    await promise;

    expect(deps.statusStore.get(1)).toBe("failed");
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed after 1 retries"),
    );
  });

  it("does not retry when retryOnCheckFailure is not enabled", async () => {
    const issue = makeIssue({ number: 1, wave: 1 });
    const { orchestrator, deps } = makeOrchestrator([issue], {
      postSessionCheck: vi.fn(async () => ({
        passed: false, summary: "Check failed",
      })),
    });

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
    runner.resolvers.get(1000)!(0);
    await promise;

    // Only one spawn (no retry)
    expect(runner.spawned.length).toBe(1);
    expect(deps.statusStore.get(1)).toBe("failed");
  });

  it("passes output from postSessionCheck through to retry prompt", async () => {
    let checkCallCount = 0;
    const issue = makeIssue({ number: 1, wave: 1 });
    const config = makeConfig([issue], {
      postSessionCheck: vi.fn(async () => {
        checkCallCount++;
        if (checkCallCount === 1) {
          return { passed: false, output: "error: unused variable 'x'" };
        }
        return { passed: true };
      }),
    });
    config.retryOnCheckFailure = { maxRetries: 1, enabled: true };
    const deps = makeDeps();
    const orchestrator = new Orchestrator(config, deps);

    const runner = deps.processRunner as ReturnType<typeof makeMockRunner>;
    const promise = orchestrator.runWave(1);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(1));
    runner.resolvers.get(1000)!(0);
    await vi.waitFor(() => expect(runner.spawned.length).toBe(2));
    runner.resolvers.get(1001)!(0);
    await promise;

    const retryArgs = runner.spawned[1].args;
    const promptIndex = retryArgs.indexOf("-p");
    expect(retryArgs[promptIndex + 1]).toContain("unused variable 'x'");
  });
});
