import { describe, it, expect } from "vitest";
import { computeWaves } from "../src/dag.js";
import type { IssueSpec } from "../src/types.js";

function spec(overrides: Partial<IssueSpec> = {}): IssueSpec {
  return {
    number: 1,
    slug: "test",
    dependsOn: [],
    description: "Test issue",
    ...overrides,
  };
}

describe("computeWaves", () => {
  describe("basic wave assignment", () => {
    it("assigns wave 1 to issues with no dependencies", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b" }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].wave).toBe(1);
      expect(issues[1].wave).toBe(1);
    });

    it("assigns wave 2 to an issue depending on a wave-1 issue", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].wave).toBe(1);
      expect(issues[1].wave).toBe(2);
    });

    it("assigns wave 3 to an issue in a chain of length 3", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
        spec({ number: 3, slug: "c", dependsOn: [2] }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].wave).toBe(1);
      expect(issues[1].wave).toBe(2);
      expect(issues[2].wave).toBe(3);
    });

    it("uses max wave of multiple dependencies", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
        spec({ number: 3, slug: "c", dependsOn: [1, 2] }),
      ];

      const issues = computeWaves(specs);

      // #3 depends on both #1 (wave 1) and #2 (wave 2), so wave 3
      expect(issues[2].wave).toBe(3);
    });
  });

  describe("deps alias", () => {
    it("copies dependsOn into deps for backward compat", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].deps).toEqual([]);
      expect(issues[1].deps).toEqual([1]);
    });
  });

  describe("input order independence", () => {
    it("computes correct waves regardless of input order", () => {
      const specs = [
        spec({ number: 3, slug: "c", dependsOn: [2] }),
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs);

      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(2);
      expect(byNumber.get(3)!.wave).toBe(3);
    });
  });

  describe("preserves extra fields", () => {
    it("preserves repo and mode fields", () => {
      const specs = [
        spec({ number: 1, slug: "a", repo: "backend", mode: "manual" }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].repo).toBe("backend");
      expect(issues[0].mode).toBe("manual");
    });
  });

  describe("error cases", () => {
    it("throws on a direct cycle (A -> B -> A)", () => {
      const specs = [
        spec({ number: 1, slug: "a", dependsOn: [2] }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      expect(() => computeWaves(specs)).toThrow(/cycle/i);
    });

    it("throws on a self-reference", () => {
      const specs = [
        spec({ number: 1, slug: "a", dependsOn: [1] }),
      ];

      expect(() => computeWaves(specs)).toThrow(/cycle/i);
    });

    it("throws on an indirect cycle (A -> B -> C -> A)", () => {
      const specs = [
        spec({ number: 1, slug: "a", dependsOn: [3] }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
        spec({ number: 3, slug: "c", dependsOn: [2] }),
      ];

      expect(() => computeWaves(specs)).toThrow(/cycle/i);
    });
  });

  describe("empty input", () => {
    it("returns empty array for empty input", () => {
      expect(computeWaves([])).toEqual([]);
    });
  });
});
