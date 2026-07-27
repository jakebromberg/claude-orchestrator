import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Issue, OrchestratorConfig, OrchestratorHooks, Status } from "../src/types.js";
import { InMemoryStatusStore } from "../src/status.js";
import { renderDashboard, readLastLogLine, startWatch } from "../src/watch.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    slug: "test-issue",
    dependsOn: [],
    description: "Test issue",
    wave: 1,
    deps: [],
    ...overrides,
  };
}

function makeConfig(
  issues: Issue[],
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    name: "Test Orchestrator",
    configDir: "/tmp/test-config",
    worktreeDir: "/tmp/test-worktrees",
    projectRoot: "/tmp/project",
    stallTimeout: 0,
    issues,
    hooks: {} as OrchestratorHooks,
    ...overrides,
  };
}

// Strip ANSI escape codes for easier assertion
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// renderDashboard
// ---------------------------------------------------------------------------

describe("renderDashboard", () => {
  it("starts with ANSI clear screen sequence", () => {
    const config = makeConfig([]);
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    expect(output.startsWith("\x1b[2J\x1b[H")).toBe(true);
  });

  it("renders title with config name", () => {
    const config = makeConfig([], { name: "My Orchestrator" });
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("My Orchestrator (watching");
  });

  it("renders column headers", () => {
    const config = makeConfig([makeIssue()]);
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Issue");
    expect(plain).toContain("Description");
    expect(plain).toContain("Wave");
    expect(plain).toContain("Status");
    expect(plain).toContain("Last Output");
  });

  it("renders separator line", () => {
    const config = makeConfig([makeIssue()]);
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("-----");
  });

  it("renders issue rows with correct data", () => {
    const issues = [
      makeIssue({ number: 32, description: "Flutter fixtures", wave: 1, repo: "frontend" }),
      makeIssue({ number: 35, description: "Playwright structure", wave: 2 }),
    ];
    const config = makeConfig(issues);
    const statusMap: Record<number, Status> = {
      32: "succeeded",
      35: "running",
    };
    const output = renderDashboard({
      config,
      getStatus: (n) => statusMap[n] ?? "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("#32");
    expect(plain).toContain("#35");
    expect(plain).toContain("Flutter fixtures");
    expect(plain).toContain("Playwright structure");
    expect(plain).toContain("succeeded");
    expect(plain).toContain("running");
    expect(plain).toContain("frontend");
  });

  it("shows repo as dash when not set", () => {
    const issues = [makeIssue({ number: 1 })];
    const config = makeConfig(issues);
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    // The row should contain a dash for the repo column
    expect(plain).toContain("-");
  });

  it("shows last log line", () => {
    const issues = [makeIssue({ number: 1 })];
    const config = makeConfig(issues);
    const output = renderDashboard({
      config,
      getStatus: () => "running",
      getLastLogLine: () => "Creating test file...",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Creating test file...");
  });

  describe("status colorization", () => {
    const statuses: [Status, string][] = [
      ["succeeded", "\x1b[0;32m"],  // GREEN
      ["failed", "\x1b[0;31m"],     // RED
      ["running", "\x1b[1;33m"],    // YELLOW
      ["interrupted", "\x1b[1;33m"],// YELLOW
      ["skipped", "\x1b[2m"],       // DIM
      ["pending", "\x1b[0m"],       // NC (no color)
    ];

    it.each(statuses)("colors %s rows correctly", (status, expectedColor) => {
      const issues = [makeIssue({ number: 1 })];
      const config = makeConfig(issues);
      const output = renderDashboard({
        config,
        getStatus: () => status,
        getLastLogLine: () => "",
      });
      expect(output).toContain(expectedColor);
    });
  });

  it("truncates long descriptions to column width", () => {
    const issues = [
      makeIssue({ description: "A very long description that should be truncated" }),
    ];
    const config = makeConfig(issues);
    const output = renderDashboard({
      config,
      getStatus: () => "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).not.toContain("A very long description that should be truncated");
  });

  it("renders totals line", () => {
    const issues = [
      makeIssue({ number: 1 }),
      makeIssue({ number: 2 }),
      makeIssue({ number: 3 }),
    ];
    const config = makeConfig(issues);
    const statusMap: Record<number, Status> = {
      1: "succeeded",
      2: "failed",
      3: "running",
    };
    const output = renderDashboard({
      config,
      getStatus: (n) => statusMap[n] ?? "pending",
      getLastLogLine: () => "",
    });
    const plain = stripAnsi(output);
    expect(plain).toContain("Succeeded: 1");
    expect(plain).toContain("Failed: 1");
    expect(plain).toContain("Running: 1");
    expect(plain).toContain("Total: 3");
  });
});

// ---------------------------------------------------------------------------
// readLastLogLine
// ---------------------------------------------------------------------------

describe("readLastLogLine", () => {
  it("returns last non-empty line from content", () => {
    const fakeTail = () => "line one\nline two\nline three\n";
    const result = readLastLogLine("/tmp/test.log", fakeTail);
    expect(result).toBe("line three");
  });

  it("returns empty string when file does not exist", () => {
    const fakeTail = () => {
      throw new Error("ENOENT");
    };
    const result = readLastLogLine("/tmp/missing.log", fakeTail);
    expect(result).toBe("");
  });

  it("strips trailing whitespace", () => {
    const fakeTail = () => "some output   \n  \n";
    const result = readLastLogLine("/tmp/test.log", fakeTail);
    expect(result).toBe("some output");
  });

  it("handles file with only whitespace lines", () => {
    const fakeTail = () => "  \n  \n\n";
    const result = readLastLogLine("/tmp/test.log", fakeTail);
    expect(result).toBe("");
  });

  it("handles single-line content", () => {
    const fakeTail = () => "only line";
    const result = readLastLogLine("/tmp/test.log", fakeTail);
    expect(result).toBe("only line");
  });
});

// ---------------------------------------------------------------------------
// startWatch
// ---------------------------------------------------------------------------

describe("startWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders immediately on start", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 1 })]);
    const statusStore = new InMemoryStatusStore();

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "",
    });

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("\x1b[2J\x1b[H");
    handle.stop();
  });

  it("refreshes on interval", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 1 })]);
    const statusStore = new InMemoryStatusStore();

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "",
      interval: 2000,
    });

    expect(writes.length).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(writes.length).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(writes.length).toBe(3);
    handle.stop();
  });

  it("stops refreshing after stop() is called", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 1 })]);
    const statusStore = new InMemoryStatusStore();

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "",
      interval: 1000,
    });

    vi.advanceTimersByTime(1000);
    const countBefore = writes.length;
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(writes.length).toBe(countBefore);
  });

  it("uses injectable readFileTail", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 1 })]);
    const statusStore = new InMemoryStatusStore();
    statusStore.set(1, "running");

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "Building components...\n",
    });

    const plain = stripAnsi(writes[0]);
    expect(plain).toContain("Building components...");
    handle.stop();
  });

  it("reads status from the status store", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 42 })]);
    const statusStore = new InMemoryStatusStore();
    statusStore.set(42, "failed");

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "",
    });

    const plain = stripAnsi(writes[0]);
    expect(plain).toContain("failed");
    handle.stop();
  });

  it("defaults to 2000ms interval", () => {
    const writes: string[] = [];
    const config = makeConfig([makeIssue({ number: 1 })]);
    const statusStore = new InMemoryStatusStore();

    const handle = startWatch({
      config,
      statusStore,
      write: (text) => writes.push(text),
      readFileTail: () => "",
    });

    expect(writes.length).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(writes.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(writes.length).toBe(2);
    handle.stop();
  });
});
