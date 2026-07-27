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

  describe("deps normalization", () => {
    it("normalizes dependsOn into ref-valued deps (bare numbers when no repo)", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs);

      expect(issues[0].deps).toEqual([]);
      expect(issues[1].deps).toEqual(["1"]);
    });

    it("sets ref to the bare number when no repo is known", () => {
      const issues = computeWaves([spec({ number: 7, slug: "a" })]);
      expect(issues[0].ref).toBe("7");
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

  describe("serial flag", () => {
    it("places each serial issue in its own wave (no deps)", () => {
      const specs = [
        spec({ number: 1, slug: "a", serial: true }),
        spec({ number: 2, slug: "b", serial: true }),
      ];

      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));

      expect(byNumber.get(1)!.wave).not.toBe(byNumber.get(2)!.wave);
    });

    it("orders serial issues by issue number", () => {
      const specs = [
        spec({ number: 5, slug: "e", serial: true }),
        spec({ number: 2, slug: "b", serial: true }),
        spec({ number: 4, slug: "d", serial: true }),
      ];

      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));

      expect(byNumber.get(2)!.wave).toBeLessThan(byNumber.get(4)!.wave);
      expect(byNumber.get(4)!.wave).toBeLessThan(byNumber.get(5)!.wave);
    });

    it("groups non-serial issues from the same base wave together, " +
      "then runs serial issues one per wave after them", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),                  // non-serial
        spec({ number: 2, slug: "b" }),                  // non-serial
        spec({ number: 3, slug: "c", serial: true }),    // serial
        spec({ number: 4, slug: "d", serial: true }),    // serial
      ];

      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));

      // Non-serials share wave 1
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(1);
      // Serials each get their own wave, after the non-serials
      expect(byNumber.get(3)!.wave).toBe(2);
      expect(byNumber.get(4)!.wave).toBe(3);
    });

    it("delays the next base wave's issues until after all serials", () => {
      const specs = [
        spec({ number: 1, slug: "a", serial: true }),
        spec({ number: 2, slug: "b", serial: true }),
        spec({ number: 3, slug: "c", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));

      // #3 depends on #1; both serials run before #3
      expect(byNumber.get(3)!.wave).toBeGreaterThan(byNumber.get(1)!.wave);
      expect(byNumber.get(3)!.wave).toBeGreaterThan(byNumber.get(2)!.wave);
    });

    it("a single serial issue alone occupies wave 1", () => {
      const specs = [spec({ number: 1, slug: "a", serial: true })];

      const issues = computeWaves(specs);

      expect(issues[0].wave).toBe(1);
    });

    it("preserves the serial flag on the returned issues", () => {
      const specs = [
        spec({ number: 1, slug: "a", serial: true }),
        spec({ number: 2, slug: "b" }),
      ];

      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));

      expect(byNumber.get(1)!.serial).toBe(true);
      expect(byNumber.get(2)!.serial).toBeUndefined();
    });
  });

  describe("cross-repo identity", () => {
    it("treats the same number in different repos as distinct nodes", () => {
      const specs = [
        spec({ number: 924, slug: "lml", repo: "WXYC/lml" }),
        spec({ number: 924, slug: "bs", repo: "WXYC/backend", dependsOn: ["WXYC/lml#924"] }),
      ];

      const issues = computeWaves(specs);
      const byRef = new Map(issues.map((i) => [i.ref, i]));

      expect(issues).toHaveLength(2);
      expect(byRef.get("WXYC/lml#924")!.wave).toBe(1);
      expect(byRef.get("WXYC/backend#924")!.wave).toBe(2);
      expect(byRef.get("WXYC/backend#924")!.deps).toEqual(["WXYC/lml#924"]);
    });

    it("does not see a false cycle when colliding numbers depend across repos", () => {
      // Under the old bare-number keying, lml#1 and bs#1 collapsed to one node
      // and bs#1 -> lml#1 looked like a self-cycle. It must not now.
      const specs = [
        spec({ number: 1, slug: "lml", repo: "WXYC/lml" }),
        spec({ number: 1, slug: "bs", repo: "WXYC/backend", dependsOn: ["WXYC/lml#1"] }),
      ];

      expect(() => computeWaves(specs)).not.toThrow();
      const issues = computeWaves(specs);
      const byRef = new Map(issues.map((i) => [i.ref, i]));
      expect(byRef.get("WXYC/lml#1")!.wave).toBe(1);
      expect(byRef.get("WXYC/backend#1")!.wave).toBe(2);
    });

    it("resolves a leading-hash dep against the citing issue's own repo", () => {
      const specs = [
        spec({ number: 1, slug: "a", repo: "WXYC/lml" }),
        spec({ number: 2, slug: "b", repo: "WXYC/lml", dependsOn: ["#1"] }),
      ];

      const issues = computeWaves(specs);
      const byRef = new Map(issues.map((i) => [i.ref, i]));
      expect(byRef.get("WXYC/lml#2")!.deps).toEqual(["WXYC/lml#1"]);
      expect(byRef.get("WXYC/lml#2")!.wave).toBe(2);
    });

    it("applies defaultRepo to repo-less issues and their bare deps", () => {
      const specs = [
        spec({ number: 1, slug: "a" }),
        spec({ number: 2, slug: "b", dependsOn: [1] }),
      ];

      const issues = computeWaves(specs, { defaultRepo: "WXYC/lml" });
      const byRef = new Map(issues.map((i) => [i.ref, i]));
      expect(byRef.get("WXYC/lml#1")!.wave).toBe(1);
      expect(byRef.get("WXYC/lml#2")!.deps).toEqual(["WXYC/lml#1"]);
    });

    it("slides same-file cross-repo conflicts deterministically by (repo, number)", () => {
      const specs = [
        spec({ number: 5, slug: "bs", repo: "WXYC/backend", ownsFiles: ["shared.ts"] }),
        spec({ number: 5, slug: "lml", repo: "WXYC/lml", ownsFiles: ["shared.ts"] }),
      ];

      const issues = computeWaves(specs);
      const byRef = new Map(issues.map((i) => [i.ref, i]));
      // "WXYC/backend" < "WXYC/lml", so backend keeps wave 1, lml slides.
      expect(byRef.get("WXYC/backend#5")!.wave).toBe(1);
      expect(byRef.get("WXYC/lml#5")!.wave).toBe(2);
    });
  });

  describe("ownsFiles conflict detection", () => {
    it("two issues with no ownsFiles in the same wave are unaffected", () => {
      const specs = [spec({ number: 1, slug: "a" }), spec({ number: 2, slug: "b" })];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(1);
    });

    it("two issues with non-overlapping ownsFiles in the same wave are unaffected", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["src/a.ts"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["src/b.ts"] }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(1);
    });

    it("slides the higher-numbered issue to the next wave when ownsFiles overlap", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["src/shared.ts"] }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(2);
    });

    it("the lower-numbered issue always keeps its original wave", () => {
      const specs = [
        spec({ number: 5, slug: "e", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 1, slug: "a", ownsFiles: ["src/shared.ts"] }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(5)!.wave).toBe(2);
    });

    it("cascades three issues claiming the same file into separate waves", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 3, slug: "c", ownsFiles: ["src/shared.ts"] }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(2);
      expect(byNumber.get(3)!.wave).toBe(3);
    });

    it("ignores files listed in ignoredOwnsFiles when checking for conflicts", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["package-lock.json"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["package-lock.json"] }),
      ];
      const issues = computeWaves(specs, { ignoredOwnsFiles: ["package-lock.json"] });
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(1);
    });

    it("only ignores the listed files, still detects conflicts on other files", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["package-lock.json", "src/shared.ts"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["package-lock.json", "src/shared.ts"] }),
      ];
      const issues = computeWaves(specs, { ignoredOwnsFiles: ["package-lock.json"] });
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(2);
    });

    it("issues in different original waves can claim the same file without conflict", () => {
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 2, slug: "b", dependsOn: [1], ownsFiles: ["src/shared.ts"] }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      // #2 is already in wave 2 due to dependsOn, no further sliding needed
      expect(byNumber.get(1)!.wave).toBe(1);
      expect(byNumber.get(2)!.wave).toBe(2);
    });

    it("preserves ownsFiles on returned issues", () => {
      const specs = [spec({ number: 1, slug: "a", ownsFiles: ["src/x.ts"] })];
      const issues = computeWaves(specs);
      expect(issues[0].ownsFiles).toEqual(["src/x.ts"]);
    });

    it("interacts correctly with serial: file conflict detection runs before serial splitting", () => {
      // Two non-serial issues own the same file; one serial issue in the same wave.
      // File conflict should push the higher-numbered non-serial; serial splitting
      // then isolates the serial issue.
      const specs = [
        spec({ number: 1, slug: "a", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 2, slug: "b", ownsFiles: ["src/shared.ts"] }),
        spec({ number: 3, slug: "c", serial: true }),
      ];
      const issues = computeWaves(specs);
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      // #1 keeps wave 1; #2 is pushed by file conflict
      expect(byNumber.get(1)!.wave).toBeLessThan(byNumber.get(2)!.wave);
      // Serial issue is alone in its wave
      const waveOf3 = byNumber.get(3)!.wave;
      const siblingsOf3 = issues.filter((i) => i.wave === waveOf3 && i.number !== 3);
      expect(siblingsOf3).toHaveLength(0);
    });
  });
});
