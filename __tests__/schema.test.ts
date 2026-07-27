import { describe, it, expect, vi } from "vitest";
import { validateConfig } from "../src/schema.js";
import type { RawOrchestratorConfig, OrchestratorHooks, IssueSpec, Status } from "../src/types.js";

function makeHooks(): OrchestratorHooks {
  return {
    showHelp: vi.fn(),
    shouldSkipIssue: vi.fn(() => ({ skip: false })),
    isRetryableStatus: vi.fn((s: Status) => s === "failed"),
    preflightCheck: vi.fn(async () => {}),
    preRunSetup: vi.fn(async () => {}),
    setUpWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    getWorktreePath: vi.fn(() => "/tmp"),
    getBranchName: vi.fn(() => "orchestrator/test"),
    interpolatePrompt: vi.fn(async () => "prompt"),
    getClaudeArgs: vi.fn(() => []),
    printSummary: vi.fn(),
  };
}

function makeRawConfig(issues: IssueSpec[]): RawOrchestratorConfig {
  return {
    name: "Test",
    configDir: "/tmp/config",
    worktreeDir: "/tmp/worktrees",
    projectRoot: "/tmp/project",
    stallTimeout: 0,
    issues,
    hooks: makeHooks(),
  };
}

function makeSpec(overrides: Partial<IssueSpec> = {}): IssueSpec {
  return {
    number: 1,
    slug: "test",
    dependsOn: [],
    description: "Test issue",
    ...overrides,
  };
}

describe("validateConfig", () => {
  describe("valid configs", () => {
    it("accepts a config with no issues", () => {
      const config = validateConfig(makeRawConfig([]));
      expect(config.issues).toEqual([]);
    });

    it("accepts a valid config with one issue", () => {
      const config = validateConfig(makeRawConfig([
        makeSpec({ number: 1, slug: "foo" }),
      ]));
      expect(config.issues).toHaveLength(1);
      expect(config.issues[0].wave).toBe(1);
      expect(config.issues[0].deps).toEqual([]);
    });

    it("accepts a valid config with dependencies", () => {
      const config = validateConfig(makeRawConfig([
        makeSpec({ number: 1, slug: "a" }),
        makeSpec({ number: 2, slug: "b", dependsOn: [1] }),
      ]));
      expect(config.issues[0].wave).toBe(1);
      expect(config.issues[1].wave).toBe(2);
    });

    it("passes through scalar config fields unchanged", () => {
      const raw = makeRawConfig([makeSpec()]);
      raw.name = "My Orchestrator";
      raw.stallTimeout = 300;

      const config = validateConfig(raw);

      expect(config.name).toBe("My Orchestrator");
      expect(config.stallTimeout).toBe(300);
      expect(config.configDir).toBe("/tmp/config");
    });

    it("passes through hooks unchanged", () => {
      const raw = makeRawConfig([makeSpec()]);
      const config = validateConfig(raw);

      expect(config.hooks).toBe(raw.hooks);
    });

    it("accepts issue with stallTimeout", () => {
      const config = validateConfig(makeRawConfig([
        makeSpec({ number: 1, slug: "slow-task", stallTimeout: 600 }),
      ]));
      expect(config.issues).toHaveLength(1);
    });

    it("accepts issue without stallTimeout", () => {
      const config = validateConfig(makeRawConfig([
        makeSpec({ number: 1, slug: "normal-task" }),
      ]));
      expect(config.issues).toHaveLength(1);
    });
  });

  describe("structural validation", () => {
    it("rejects issue with negative number", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ number: -1 })]))
      ).toThrow();
    });

    it("rejects issue with number 0", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ number: 0 })]))
      ).toThrow();
    });

    it("rejects issue with empty slug", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ slug: "" })]))
      ).toThrow();
    });

    it("rejects issue with empty description", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ description: "" })]))
      ).toThrow();
    });

    it("rejects negative stallTimeout", () => {
      const raw = makeRawConfig([makeSpec()]);
      raw.stallTimeout = -1;
      expect(() => validateConfig(raw)).toThrow();
    });

    it("rejects empty name", () => {
      const raw = makeRawConfig([makeSpec()]);
      raw.name = "";
      expect(() => validateConfig(raw)).toThrow();
    });

    it("rejects negative issue stallTimeout", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ stallTimeout: -1 })]))
      ).toThrow();
    });

    it("rejects non-integer issue stallTimeout", () => {
      expect(() =>
        validateConfig(makeRawConfig([makeSpec({ stallTimeout: 1.5 })]))
      ).toThrow();
    });
  });

  describe("referential validation", () => {
    it("rejects duplicate issue numbers", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "a" }),
          makeSpec({ number: 1, slug: "b" }),
        ]))
      ).toThrow(/duplicate.*number/i);
    });

    it("rejects duplicate slugs", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "same" }),
          makeSpec({ number: 2, slug: "same" }),
        ]))
      ).toThrow(/duplicate.*slug/i);
    });

    it("rejects dangling dependency reference", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "a", dependsOn: [999] }),
        ]))
      ).toThrow(/999/);
    });

    it("rejects self-referencing dependency", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "a", dependsOn: [1] }),
        ]))
      ).toThrow(/self/i);
    });
  });

  describe("graph validation", () => {
    it("rejects a direct cycle", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "a", dependsOn: [2] }),
          makeSpec({ number: 2, slug: "b", dependsOn: [1] }),
        ]))
      ).toThrow(/cycle/i);
    });

    it("rejects an indirect cycle", () => {
      expect(() =>
        validateConfig(makeRawConfig([
          makeSpec({ number: 1, slug: "a", dependsOn: [3] }),
          makeSpec({ number: 2, slug: "b", dependsOn: [1] }),
          makeSpec({ number: 3, slug: "c", dependsOn: [2] }),
        ]))
      ).toThrow(/cycle/i);
    });
  });
});
