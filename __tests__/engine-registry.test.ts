import { describe, it, expect, vi } from "vitest";
import { refOf } from "../src/ref.js";
import { Orchestrator } from "../src/engine.js";
import { InMemoryStatusStore, InMemoryMetadataStore } from "../src/status.js";
import type { Deps, EngineRegistry, Issue, OrchestratorConfig, OrchestratorHooks } from "../src/types.js";

function makeIssue(number: number, stallTimeout?: number): Issue {
  const base = { number, slug: `issue-${number}`, wave: 1, dependsOn: [], description: `Issue ${number}` };
  return { ...base, ref: refOf(base), deps: [], ...(stallTimeout !== undefined ? { stallTimeout } : {}) };
}

function setUp(issues: Issue[]) {
  const registry: EngineRegistry & { calls: unknown[][] } = {
    calls: [] as unknown[][],
    start(info) { this.calls.push(["start", info]); },
    stop() { this.calls.push(["stop"]); },
  };
  const config = {
    name: "t", configDir: "/tmp/c", worktreeDir: "/tmp/w", projectRoot: "/tmp/p", stallTimeout: 600, issues,
    hooks: {} as OrchestratorHooks,
  } as OrchestratorConfig;
  const deps = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() }, engineRegistry: registry } as unknown as Deps;
  return { orchestrator: new Orchestrator(config, deps), registry };
}

describe("engine registry lifecycle", () => {
  it("starts before the run and stops after it, reporting the largest effective stall timeout", async () => {
    const { orchestrator, registry } = setUp([makeIssue(1), makeIssue(2, 1800), makeIssue(3, 60)]);
    await orchestrator.runRegistered("run-1", async () => { registry.calls.push(["run"]); });

    expect(registry.calls).toEqual([
      ["start", { runId: "run-1", logDir: "/tmp/c/logs", stallTimeout: 1800 }],
      ["run"],
      ["stop"],
    ]);
  });

  it("stops after a failed run and rethrows", async () => {
    const { orchestrator, registry } = setUp([makeIssue(1)]);
    await expect(orchestrator.runRegistered("run-1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");

    expect(registry.calls.map(([c]) => c)).toEqual(["start", "stop"]);
  });

  it("runs unregistered when deps has no registry", async () => {
    const { orchestrator } = setUp([makeIssue(1)]);
    (orchestrator as unknown as { deps: Deps }).deps.engineRegistry = undefined;
    const run = vi.fn(async () => {});
    await orchestrator.runRegistered("run-1", run);

    expect(run).toHaveBeenCalledOnce();
  });

  it("runs the work when the registry throws from start or stop", async () => {
    const { orchestrator } = setUp([makeIssue(1)]);
    (orchestrator as unknown as { deps: Deps }).deps.engineRegistry = {
      start() { throw new Error("start"); },
      stop() { throw new Error("stop"); },
    };
    const run = vi.fn(async () => {});
    await expect(orchestrator.runRegistered("run-1", run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(() => orchestrator.stopEngineRegistry()).not.toThrow();
  });
});
