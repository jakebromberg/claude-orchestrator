import { describe, it, expect, afterEach, vi } from "vitest";
import { createDashboardServer } from "../src/dashboard.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import { createSilentLogger } from "../src/log.js";
import type { OrchestratorConfig, Issue } from "../src/types.js";
import type { DashboardDeps } from "../src/dashboard-types.js";
import type { DashboardHandle } from "../src/dashboard-types.js";

function makeIssue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    slug: `issue-${overrides.number}`,
    description: `Issue ${overrides.number}`,
    dependsOn: [],
    wave: 1,
    deps: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  const issues: Issue[] = [
    makeIssue({ number: 1, slug: "auth", description: "Add auth", wave: 1 }),
    makeIssue({ number: 2, slug: "api", description: "Add API", wave: 2, deps: [1] }),
  ];

  return {
    statusStore: new InMemoryStatusStore(),
    metadataStore: new InMemoryMetadataStore(),
    config: {
      name: "test-project",
      configDir: "/tmp/test",
      worktreeDir: "/tmp/worktrees",
      projectRoot: "/tmp",
      stallTimeout: 300,
      issues,
      hooks: {} as OrchestratorConfig["hooks"],
    },
    logger: createSilentLogger(),
    readLogTail: () => "last log line",
    ...overrides,
  };
}

// Use a random port for each test to avoid conflicts
let nextPort = 19100;
function getPort(): number {
  return nextPort++;
}

describe("dashboard server", () => {
  let handle: DashboardHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("serves HTML on GET /", async () => {
    const port = getPort();
    handle = await createDashboardServer(makeDeps(), { port });

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("test-project");
    expect(body).toContain("<!DOCTYPE html>");
  });

  it("returns issue statuses on GET /api/status", async () => {
    const deps = makeDeps();
    deps.statusStore.set(1, "running");
    deps.statusStore.set(2, "pending");
    const port = getPort();
    handle = await createDashboardServer(deps, { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.status).toBe(200);

    const data = await res.json() as Array<{ number: number; status: string }>;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ number: 1, status: "running", slug: "auth" });
    expect(data[1]).toMatchObject({ number: 2, status: "pending", slug: "api" });
  });

  it("returns config on GET /api/config", async () => {
    const port = getPort();
    handle = await createDashboardServer(makeDeps(), { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    const data = await res.json() as { name: string; issues: Array<{ number: number; slug: string; wave: number }> };

    expect(data.name).toBe("test-project");
    expect(data.issues).toHaveLength(2);
    expect(data.issues[0]).toMatchObject({ number: 1, slug: "auth", wave: 1 });
    expect(data.issues[1]).toMatchObject({ number: 2, slug: "api", wave: 2 });
  });

  it("returns log tail on GET /api/logs/:issue", async () => {
    const readLogTail = vi.fn().mockReturnValue("test output line");
    const port = getPort();
    handle = await createDashboardServer(makeDeps({ readLogTail }), { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/logs/1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("test output line");
    expect(readLogTail).toHaveBeenCalledWith(1, 8192);
  });

  it("returns fallback when log read fails", async () => {
    const readLogTail = vi.fn().mockImplementation(() => { throw new Error("ENOENT"); });
    const port = getPort();
    handle = await createDashboardServer(makeDeps({ readLogTail }), { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/logs/99`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("(no log output)");
  });

  it("returns metadata on GET /api/metadata/:issue", async () => {
    const deps = makeDeps();
    deps.metadataStore.set(1, { prUrl: "https://github.com/test/pr/1", exitCode: 0 });
    const port = getPort();
    handle = await createDashboardServer(deps, { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/metadata/1`);
    const data = await res.json() as { prUrl: string; exitCode: number };
    expect(data.prUrl).toBe("https://github.com/test/pr/1");
    expect(data.exitCode).toBe(0);
  });

  it("returns 404 for unknown routes", async () => {
    const port = getPort();
    handle = await createDashboardServer(makeDeps(), { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/unknown`);
    expect(res.status).toBe(404);

    const data = await res.json() as { error: string };
    expect(data.error).toBe("Not found");
  });

  it("establishes SSE connection on GET /api/events", async () => {
    const port = getPort();
    handle = await createDashboardServer(makeDeps(), { port });

    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Clean up the SSE connection
    if (res.body) {
      await res.body.cancel();
    }
  });

  it("emits SSE events when status changes", async () => {
    const deps = makeDeps();
    deps.statusStore.set(1, "pending");
    const port = getPort();
    handle = await createDashboardServer(deps, { port });

    // Connect to SSE
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });

    // Change status — the polling interval is 2s, so we wait a bit
    deps.statusStore.set(1, "succeeded");

    // Read from the SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    const timeout = Date.now() + 5000;

    while (Date.now() < timeout) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 3000)
        ),
      ]);
      if (done && !accumulated.includes("event: status")) break;
      if (value) accumulated += decoder.decode(value, { stream: true });
      if (accumulated.includes("event: status")) break;
    }

    controller.abort();

    expect(accumulated).toContain("event: status");
    expect(accumulated).toContain('"succeeded"');
  });
});
