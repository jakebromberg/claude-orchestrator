import { describe, it, expect } from "vitest";
import {
  isModeNode,
  isCommandNode,
  isManualGate,
  cutoverReason,
  MODE_NODE_KINDS,
} from "../src/mode-node.js";
import { refOf, normalizeDep } from "../src/ref.js";
import type { Issue } from "../src/types.js";

function mk(
  overrides: Omit<Partial<Issue>, "deps"> & { number: number; dependsOn?: (number | string)[] },
): Issue {
  const { dependsOn = [], ...rest } = overrides;
  const base = {
    slug: `issue-${overrides.number}`,
    description: "d",
    dependsOn,
    ...rest,
  };
  return {
    ...base,
    wave: 1,
    ref: refOf(base),
    deps: dependsOn.map((d) => normalizeDep(d, base)),
  };
}

function lookupOf(issues: Issue[]): (ref: string) => Issue | undefined {
  const byRef = new Map(issues.map((i) => [i.ref, i]));
  return (ref) => byRef.get(ref);
}

describe("mode-node classification", () => {
  describe("isModeNode", () => {
    it.each(MODE_NODE_KINDS)("is true for the recognized mode %s", (mode) => {
      expect(isModeNode({ mode })).toBe(true);
    });

    it("is false when mode is unset (a normal Claude node)", () => {
      expect(isModeNode({})).toBe(false);
      expect(isModeNode({ mode: undefined })).toBe(false);
    });

    it("is false for an unrecognized mode string", () => {
      expect(isModeNode({ mode: "implement" })).toBe(false);
      expect(isModeNode({ mode: "" })).toBe(false);
    });

    it("exposes exactly deploy, publish, gate", () => {
      expect([...MODE_NODE_KINDS]).toEqual(["deploy", "publish", "gate"]);
    });
  });

  describe("isCommandNode", () => {
    it("is true for a mode-node with a non-empty command", () => {
      expect(isCommandNode({ mode: "deploy", command: "gh workflow run deploy.yml" })).toBe(true);
    });

    it("is false for a mode-node without a command", () => {
      expect(isCommandNode({ mode: "gate" })).toBe(false);
      expect(isCommandNode({ mode: "deploy", command: "" })).toBe(false);
    });

    it("is false for a normal node even if it somehow carries a command", () => {
      expect(isCommandNode({ command: "echo hi" })).toBe(false);
      expect(isCommandNode({ mode: undefined, command: "echo hi" })).toBe(false);
    });
  });

  describe("isManualGate", () => {
    it("is true for a mode-node without a command", () => {
      expect(isManualGate({ mode: "gate" })).toBe(true);
      expect(isManualGate({ mode: "deploy" })).toBe(true);
    });

    it("is false for a command node and for a normal node", () => {
      expect(isManualGate({ mode: "gate", command: "gh workflow run smoke.yml" })).toBe(false);
      expect(isManualGate({})).toBe(false);
    });
  });
});

describe("cutoverReason", () => {
  it("returns undefined for a normal node with same-repo deps", () => {
    const a = mk({ number: 1, repo: "WXYC/lml" });
    const b = mk({ number: 2, repo: "WXYC/lml", dependsOn: [1] });
    expect(cutoverReason(b, lookupOf([a, b]))).toBeUndefined();
  });

  it("gates a command-less manual gate node without a stutter", () => {
    const gate = mk({ number: 1, repo: "WXYC/lml", mode: "gate" });
    expect(cutoverReason(gate, lookupOf([gate]))).toBe("manual gate");
  });

  it("names the kind for a command-less deploy/publish gate", () => {
    const deploy = mk({ number: 1, repo: "WXYC/lml", mode: "deploy" });
    expect(cutoverReason(deploy, lookupOf([deploy]))).toBe("manual deploy gate");
  });

  it("gates a bare cross-repo edge into a plain node", () => {
    const upstream = mk({ number: 1, repo: "WXYC/wxyc-shared" });
    const consumer = mk({ number: 2, repo: "WXYC/backend", dependsOn: ["WXYC/wxyc-shared#1"] });
    expect(cutoverReason(consumer, lookupOf([upstream, consumer]))).toMatch(/cross-repo/i);
  });

  it("does NOT gate a cross-repo edge whose dep is a command mode-node", () => {
    // The publish node's command success is itself the cutover — no manual confirm.
    const publish = mk({ number: 1, repo: "WXYC/wxyc-shared", mode: "publish", command: "npm publish" });
    const consumer = mk({ number: 2, repo: "WXYC/backend", dependsOn: ["WXYC/wxyc-shared#1"] });
    expect(cutoverReason(consumer, lookupOf([publish, consumer]))).toBeUndefined();
  });

  it("does NOT gate a cross-repo edge whose dep is a manual gate", () => {
    // The upstream manual gate's own confirmation already served as the cutover.
    const gate = mk({ number: 1, repo: "WXYC/wxyc-shared", mode: "gate" });
    const consumer = mk({ number: 2, repo: "WXYC/backend", dependsOn: ["WXYC/wxyc-shared#1"] });
    expect(cutoverReason(consumer, lookupOf([gate, consumer]))).toBeUndefined();
  });

  it("gates when one of several deps is a bare cross-repo plain node", () => {
    const sameRepo = mk({ number: 1, repo: "WXYC/backend" });
    const crossRepo = mk({ number: 2, repo: "WXYC/wxyc-shared" });
    const consumer = mk({
      number: 3, repo: "WXYC/backend",
      dependsOn: [1, "WXYC/wxyc-shared#2"], // one same-repo, one cross-repo plain
    });
    expect(
      cutoverReason(consumer, lookupOf([sameRepo, crossRepo, consumer])),
    ).toMatch(/cross-repo/i);
  });

  it("does not gate a single-repo run (bare refs, no repo)", () => {
    const a = mk({ number: 1 });
    const b = mk({ number: 2, dependsOn: [1] });
    expect(cutoverReason(b, lookupOf([a, b]))).toBeUndefined();
  });

  it("still gates a manual gate that also has a satisfied cross-repo dep", () => {
    const publish = mk({ number: 1, repo: "WXYC/wxyc-shared", mode: "publish", command: "npm publish" });
    const gate = mk({ number: 2, repo: "WXYC/backend", mode: "gate", dependsOn: ["WXYC/wxyc-shared#1"] });
    expect(cutoverReason(gate, lookupOf([publish, gate]))).toMatch(/manual/i);
  });
});
