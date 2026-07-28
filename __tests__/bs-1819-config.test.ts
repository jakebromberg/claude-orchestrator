import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { loadYamlConfig } from "../src/yaml-loader.js";
import { isModeNode, isCommandNode, isManualGate, cutoverReason } from "../src/mode-node.js";
import { resolveModelEffort, modelEffortInputs } from "../src/model-effort.js";
import { renderPlanPreview } from "../src/plan-preview.js";
import type { Issue, OrchestratorConfig } from "../src/types.js";

// The first real cross-repo config is a tracked artifact — guard its wave
// partition and cutover-gate structure against schema/DAG drift.
const CONFIG_PATH = fileURLToPath(
  new URL("../wxyc/bs-1819/config.yaml", import.meta.url),
);

// Worktree hooks have no universal default; a stub satisfies loadYamlConfig
// without touching git (the plan/wave computation never calls them).
const stubHooks = {
  getWorktreePath: () => "/tmp/wt",
  getBranchName: (i: Issue) => `orchestrator/${i.slug}`,
  setUpWorktree: async () => {},
  removeWorktree: async () => {},
};

describe("wxyc/bs-1819 config", () => {
  let config: OrchestratorConfig;
  let byRef: Map<string, Issue>;

  beforeAll(async () => {
    config = await loadYamlConfig(CONFIG_PATH, { hooksOverride: stubHooks });
    byRef = new Map(config.issues.map((i) => [i.ref, i]));
  });

  const LML = "WXYC/library-metadata-lookup";
  const CANARY = "WXYC/wxyc-canary";
  const IOS = "WXYC/wxyc-ios-64";

  it("loads and validates (no cycle, no dangling refs)", () => {
    expect(config.issues).toHaveLength(11);
  });

  it("places every node in the expected wave", () => {
    const waveOf = (ref: string) => byRef.get(ref)?.wave;
    // Wave 1: independent LML work
    expect(waveOf(`${LML}#924`)).toBe(1);
    expect(waveOf(`${LML}#926`)).toBe(1);
    expect(waveOf(`${LML}#928`)).toBe(1);
    expect(waveOf(`${LML}#930`)).toBe(1);
    expect(waveOf(`${LML}#931`)).toBe(1);
    // Wave 2: builds on wave 1
    expect(waveOf(`${LML}#927`)).toBe(2);
    expect(waveOf(`${LML}#929`)).toBe(2);
    // Wave 3-6: deploy → verify → gate → consume
    expect(waveOf(`${LML}#9001`)).toBe(3); // deploy-lml
    expect(waveOf(`${CANARY}#82`)).toBe(4);
    expect(waveOf(`${CANARY}#9002`)).toBe(5); // wait-canary
    expect(waveOf(`${IOS}#685`)).toBe(6);
  });

  it("models deploy-lml as a command mode-node", () => {
    const deploy = byRef.get(`${LML}#9001`)!;
    expect(isModeNode(deploy)).toBe(true);
    expect(isCommandNode(deploy)).toBe(true);
    expect(deploy.command).toContain("gh workflow run deploy.yml");
  });

  it("models wait-canary as a command-less manual gate", () => {
    const gate = byRef.get(`${CANARY}#9002`)!;
    expect(isModeNode(gate)).toBe(true);
    expect(isManualGate(gate)).toBe(true);
  });

  it("has exactly one HITL cutover gate: wait-canary", () => {
    const lookup = (ref: string) => byRef.get(ref);
    const gated = config.issues.filter((i) => cutoverReason(i, lookup) !== undefined);
    expect(gated.map((i) => i.ref)).toEqual([`${CANARY}#9002`]);
  });

  it("does not gate the cross-repo edges into mode-nodes", () => {
    const lookup = (ref: string) => byRef.get(ref);
    // canary#82 ← deploy-lml (command node) and ios#685 ← wait-canary (gate) —
    // the mode-node is the cutover, so the dependent is not itself gated.
    expect(cutoverReason(byRef.get(`${CANARY}#82`)!, lookup)).toBeUndefined();
    expect(cutoverReason(byRef.get(`${IOS}#685`)!, lookup)).toBeUndefined();
  });

  it("assigns opus to the concurrency-critical LML issues, sonnet elsewhere", () => {
    const modelOf = (ref: string) =>
      resolveModelEffort(modelEffortInputs(byRef.get(ref)!, config)).model;
    expect(modelOf(`${LML}#927`)).toBe("opus");
    expect(modelOf(`${LML}#929`)).toBe("opus");
    expect(modelOf(`${LML}#930`)).toBe("opus");
    expect(modelOf(`${LML}#924`)).toBe("sonnet");
    expect(modelOf(`${LML}#931`)).toBe("sonnet");
  });

  it("derives effort from complexity (complex → high, normal → medium)", () => {
    const effortOf = (ref: string) =>
      resolveModelEffort(modelEffortInputs(byRef.get(ref)!, config)).effort;
    expect(effortOf(`${LML}#929`)).toBe("high"); // complex
    expect(effortOf(`${LML}#924`)).toBe("medium"); // normal
  });

  it("resolves per-repo base branches (iOS master, others main)", () => {
    // getBaseBranch comes from the repos: map via the YAML hook layer.
    expect(config.hooks.getBaseBranch?.(byRef.get(`${IOS}#685`)!)).toBe("master");
    expect(config.hooks.getBaseBranch?.(byRef.get(`${LML}#924`)!)).toBe("main");
    expect(config.hooks.getBaseBranch?.(byRef.get(`${CANARY}#82`)!)).toBe("main");
  });

  it("renders a --plan preview with the single gate surfaced", () => {
    const out = renderPlanPreview(config);
    expect(out).toContain("bs-1819");
    expect(out).toContain("11 issues");
    expect(out).toContain("6 waves");
    expect(out).toContain("2 mode-nodes");
    expect(out).toContain("1 HITL gate");
    expect(out).toContain("HITL cutover gates");
    expect(out).toMatch(/WXYC\/wxyc-canary#9002[\s\S]*manual/);
  });
});
