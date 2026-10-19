import { describe, it, expect, vi } from "vitest";
import { refOf } from "../src/ref.js";
import { Orchestrator } from "../src/engine.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import type { Issue, OrchestratorConfig, OrchestratorHooks, Deps, Status } from "../src/types.js";

const LOG = "/tmp/c/logs/issue-1.log";
const STOP = "orchestrator-stop: lease-wait";

const record = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", ...fields });
/** A session's terminal `result` record whose text is `text`. */
const result = (text: string) => record({ result: text });
const init = (sid: string) => JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const transcript = (...lines: string[]) => lines.join("\n") + "\n";

function setUp(opts: { logSize?: number; retries?: number; check?: OrchestratorHooks["postSessionCheck"] } = {}) {
  const base = { number: 1, slug: "issue-1", wave: 1, dependsOn: [], description: "Issue 1" };
  const issue: Issue = { ...base, ref: refOf(base), deps: [] };
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
    postSessionCheck: opts.check,
  };
  const config: OrchestratorConfig = {
    name: "t", configDir: "/tmp/c", worktreeDir: "/tmp/w", projectRoot: "/tmp/p", stallTimeout: 0, issues: [issue], hooks,
  };
  if (opts.retries) config.retryOnCheckFailure = { maxRetries: opts.retries, enabled: true };

  let nextPid = 1000;
  const resolvers = new Map<number, (code: number) => void>();
  const spawned: string[][] = [];
  const processRunner = {
    spawn(_c: string, args: string[]) {
      const pid = nextPid++;
      spawned.push(args);
      return { pid, issueNumber: 0, exitCode: new Promise<number>((r) => resolvers.set(pid, r)) };
    },
    kill() {},
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() };
  const state = { log: "" };
  const readFile = vi.fn((path: string) => {
    if (path !== LOG) throw new Error(`ENOENT ${path}`);
    return state.log;
  });
  const deps: Deps = {
    statusStore: new InMemoryStatusStore(),
    metadataStore: new InMemoryMetadataStore(),
    processRunner,
    logger,
    generateSessionId: () => "sid",
    commandExists: () => true,
    getLogFileSize: () => opts.logSize ?? 100,
    readFile,
    runCommand: vi.fn((cmd: string) => (cmd.includes("rev-list --count") ? "3" : "")),
    runCommandAsync: vi.fn(async () => ""),
    truncateFile: vi.fn(),
  };
  const orchestrator = new Orchestrator(config, deps, {});
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    orchestrator, state, spawned, logger, readFile, flush,
    exit: (pid: number, code: number) => resolvers.get(pid)!(code),
    status: (): Status => deps.statusStore.get("1"),
    meta: () => deps.metadataStore.get("1"),
    logReads: () => readFile.mock.calls.filter(([p]) => p === LOG).length,
  };
}

const failedAsLeaseWait = (t: ReturnType<typeof setUp>) => {
  expect(t.status()).toBe("failed");
  expect(t.meta()).toMatchObject({ failureReason: "lease-wait", stopStage: "session" });
};

describe("a session that declares a lease-wait stop", () => {
  it("fails with commits and a green check, skipping the check and any retry", async () => {
    const check = vi.fn(async () => ({ passed: true }));
    const t = setUp({ check, retries: 2 });
    t.state.log = transcript(result(`gave up\n${STOP}`));
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await wave;

    failedAsLeaseWait(t);
    expect(check).not.toHaveBeenCalled();
    expect(t.spawned).toHaveLength(1);
    expect(t.logger.error).toHaveBeenCalledWith(expect.stringContaining("#1"));
    expect(t.logReads()).toBe(1);
  });

  it("is honoured after the 0-byte retry, reading the log once per attempt", async () => {
    const check = vi.fn(async () => ({ passed: true }));
    const t = setUp({ check, logSize: 0 });
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 1); // 0-byte failure: retried once
    await t.flush();
    t.state.log = transcript(result(STOP));
    t.exit(1001, 0);
    await wave;

    expect(t.spawned).toHaveLength(2);
    failedAsLeaseWait(t);
    expect(check).not.toHaveBeenCalled();
    expect(t.logReads()).toBe(2);
  });

  it("is honoured after a check-failure retry, counting only the retry's own record", async () => {
    const check = vi.fn(async () => ({ passed: false, output: "lint", summary: "lint" }));
    const t = setUp({ check, retries: 2 });
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await t.flush();
    expect(t.spawned).toHaveLength(2);
    t.state.log = transcript(result("first attempt"), result(`retry\n${STOP}`));
    t.exit(1001, 0);
    await wave;

    failedAsLeaseWait(t);
    expect(check).toHaveBeenCalledTimes(1);
    expect(t.spawned).toHaveLength(2);
  });

  it("ignores the line in an earlier attempt's record when the retry's own record lacks it", async () => {
    const check = vi.fn(async () => ({ passed: false, output: "lint", summary: "lint" }));
    const t = setUp({ check, retries: 1 });
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await t.flush();
    t.state.log = transcript(result(STOP), result("retry done"));
    t.exit(1001, 0);
    await wave;

    expect(check).toHaveBeenCalledTimes(2);
    expect(t.status()).toBe("failed"); // the check kept failing; the stop did not apply
    expect(t.meta().failureReason).toBeUndefined();
  });
});

describe("transcripts that declare a stop", () => {
  it.each([
    ["the session's record followed by a hook-tagged result record", transcript(result(STOP), record({ hook_event_name: "Stop", result: "x" }))],
    ["the session's record followed by a hook_event-tagged system-style result", transcript(result(STOP), record({ hook_event: "Stop", result: "x" }))],
    ["an appended log whose last run declares it", transcript(init("a"), result("old"), init("b"), result(STOP))],
    ["CRLF line endings", transcript(result(`gave up\r\n${STOP}\r\n`))],
    ["a partial last line after the session's record", transcript(result(STOP)) + '{"type":"result","resu'],
    // Only a system/init record starts a new run: neither another system record nor an "init" subtype on another type does.
    ["the session's record followed by a non-init system record", transcript(result(STOP), JSON.stringify({ type: "system", subtype: "status", result: "x" }))],
    ["the session's record followed by a non-system record with subtype init", transcript(result(STOP), JSON.stringify({ type: "assistant", subtype: "init" }))],
  ])("stops for %s", async (_name, log) => {
    const check = vi.fn(async () => ({ passed: true }));
    const t = setUp({ check });
    t.state.log = log;
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await wave;

    failedAsLeaseWait(t);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("transcripts that do not declare a stop", () => {
  it.each([
    ["an earlier non-final result record", transcript(result(STOP), result("done"))],
    ["a hook-tagged result record after the real one", transcript(result("done"), record({ hook_event_name: "Stop", result: STOP }))],
    ["an assistant message", transcript(JSON.stringify({ type: "assistant", message: { content: STOP } }), result("done"))],
    ["a line that is not the whole line", transcript(result(`I will print ${STOP} when done`))],
    ["different case", transcript(result("Orchestrator-Stop: lease-wait"))],
    ["no space after the colon", transcript(result("orchestrator-stop:lease-wait"))],
    ["a stop from an earlier run followed by a new run with no result", transcript(init("a"), result(STOP), init("b"), JSON.stringify({ type: "assistant" }))],
    ["a non-string result that must not fall back to an earlier record", transcript(result(STOP), record({ result: null }))],
    ["an unparseable transcript", "not json\n"],
    ["an empty transcript", ""],
  ])("treats %s as an ordinary exit", async (_name, log) => {
    const check = vi.fn(async () => ({ passed: true }));
    const t = setUp({ check });
    t.state.log = log;
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await wave;

    expect(check).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe("succeeded");
    expect(t.meta().failureReason).toBeUndefined();
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it.each(["disk-full", "lease-wait.", "lease-wait "])("ignores the unknown reason %j with one warning", async (reason) => {
    const check = vi.fn(async () => ({ passed: true }));
    const t = setUp({ check });
    t.state.log = transcript(result(`orchestrator-stop: ${reason}`));
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 0);
    await wave;

    expect(check).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe("succeeded");
    const warnings = t.logger.warn.mock.calls.filter(([m]) => String(m).includes("orchestrator-stop"));
    expect(warnings).toHaveLength(1);
  });

  it("does not honour the stop when the session exited non-zero", async () => {
    const t = setUp({ check: vi.fn(async () => ({ passed: true })) });
    t.state.log = transcript(result(STOP));
    const wave = t.orchestrator.runWave(1);
    await t.flush();
    t.exit(1000, 1);
    await wave;

    expect(t.status()).toBe("failed");
    expect(t.meta().failureReason).toBeUndefined();
  });
});
