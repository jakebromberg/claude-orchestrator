import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveHooks } from "../src/yaml-hooks.js";
import type { YamlConfig } from "../src/yaml-types.js";
import type { Issue, Status } from "../src/types.js";

function makeYaml(overrides: Partial<YamlConfig> = {}): YamlConfig {
  return {
    name: "Test Orchestrator",
    configDir: "/tmp/config",
    worktreeDir: "/tmp/worktrees",
    projectRoot: "/tmp/project",
    stallTimeout: 300,
    issues: [
      { number: 1, slug: "foo", dependsOn: [], description: "Foo issue" },
      { number: 2, slug: "bar", dependsOn: [1], description: "Bar issue" },
    ],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    slug: "foo",
    dependsOn: [],
    description: "Foo issue",
    wave: 1,
    deps: [],
    ...overrides,
  };
}

describe("deriveHooks", () => {
  describe("getWorktreePath", () => {
    it("returns worktreeDir/slug", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.getWorktreePath(makeIssue({ slug: "my-feature" }))).toBe(
        "/tmp/worktrees/my-feature",
      );
    });
  });

  describe("getBranchName", () => {
    it("defaults to orchestrator/<slug>", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.getBranchName(makeIssue({ slug: "feat" }))).toBe("orchestrator/feat");
    });

    it("uses branchPrefix when provided", () => {
      const hooks = deriveHooks(makeYaml({ branchPrefix: "parity/" }));
      expect(hooks.getBranchName(makeIssue({ slug: "feat" }))).toBe("parity/feat");
    });
  });

  describe("isRetryableStatus", () => {
    it("defaults to only 'failed'", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.isRetryableStatus("failed")).toBe(true);
      expect(hooks.isRetryableStatus("interrupted")).toBe(false);
      expect(hooks.isRetryableStatus("succeeded")).toBe(false);
    });

    it("uses retryableStatuses when provided", () => {
      const hooks = deriveHooks(
        makeYaml({ retryableStatuses: ["failed", "interrupted"] }),
      );
      expect(hooks.isRetryableStatus("failed")).toBe(true);
      expect(hooks.isRetryableStatus("interrupted")).toBe(true);
      expect(hooks.isRetryableStatus("succeeded")).toBe(false);
    });
  });

  describe("shouldSkipIssue", () => {
    it("never skips", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.shouldSkipIssue(makeIssue())).toEqual({ skip: false });
    });
  });

  describe("showHelp", () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it("prints the config name", () => {
      const hooks = deriveHooks(makeYaml({ name: "My Orchestrator" }));
      hooks.showHelp();
      const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("My Orchestrator");
    });

    it("lists issue numbers and descriptions", () => {
      const hooks = deriveHooks(makeYaml());
      hooks.showHelp();
      const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("#1");
      expect(output).toContain("Foo issue");
      expect(output).toContain("#2");
      expect(output).toContain("Bar issue");
    });
  });

  describe("getClaudeArgs", () => {
    it("returns empty array by default", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.getClaudeArgs(makeIssue())).toEqual([]);
    });

    it("interpolates variables in claudeArgs", () => {
      const hooks = deriveHooks(
        makeYaml({
          claudeArgs: ["--add-dir", "{{projectRoot}}", "--issue", "{{ISSUE_NUMBER}}"],
        }),
      );
      const issue = makeIssue({ number: 42, slug: "test", description: "desc" });
      const result = hooks.getClaudeArgs(issue);
      expect(result).toEqual(["--add-dir", "/tmp/project", "--issue", "42"]);
    });

    it("interpolates SLUG and DESCRIPTION", () => {
      const hooks = deriveHooks(
        makeYaml({ claudeArgs: ["{{SLUG}}", "{{DESCRIPTION}}"] }),
      );
      const issue = makeIssue({ slug: "my-slug", description: "My desc" });
      expect(hooks.getClaudeArgs(issue)).toEqual(["my-slug", "My desc"]);
    });

    it("interpolates configDir and worktreeDir", () => {
      const hooks = deriveHooks(
        makeYaml({ claudeArgs: ["{{configDir}}", "{{worktreeDir}}"] }),
      );
      expect(hooks.getClaudeArgs(makeIssue())).toEqual(["/tmp/config", "/tmp/worktrees"]);
    });
  });

  describe("interpolatePrompt", () => {
    it("returns a default prompt when no promptTemplate is set", async () => {
      const hooks = deriveHooks(makeYaml());
      const issue = makeIssue({ number: 5, description: "Fix the bug" });
      const result = await hooks.interpolatePrompt(issue);
      expect(result).toBe("Fix issue #5: Fix the bug");
    });

    it("reads and interpolates a promptTemplate file", async () => {
      const readFile = vi.fn().mockReturnValue("Fix {{ISSUE_NUMBER}}: {{DESCRIPTION}} in {{projectRoot}}");
      const hooks = deriveHooks(makeYaml({ promptTemplate: "/tmp/prompt.md" }), {
        readFile,
      });
      const issue = makeIssue({ number: 3, description: "Add feature" });
      const result = await hooks.interpolatePrompt(issue);
      expect(result).toBe("Fix 3: Add feature in /tmp/project");
      expect(readFile).toHaveBeenCalledWith("/tmp/prompt.md");
    });
  });

  describe("postSessionCheck", () => {
    it("is undefined when not configured", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.postSessionCheck).toBeUndefined();
    });

    it("runs commands and returns passed when all succeed", async () => {
      const runCommand = vi.fn().mockReturnValue("");
      const hooks = deriveHooks(
        makeYaml({
          postSessionCheck: { commands: ["npm test", "npx tsc"], cwd: "scripts" },
        }),
        { runCommand },
      );
      const issue = makeIssue({ slug: "feat" });
      const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/feat");
      expect(result.passed).toBe(true);
      expect(runCommand).toHaveBeenCalledTimes(2);
      expect(runCommand).toHaveBeenCalledWith("npm test", "/tmp/worktrees/feat/scripts");
      expect(runCommand).toHaveBeenCalledWith("npx tsc", "/tmp/worktrees/feat/scripts");
    });

    it("uses worktree root when cwd is not specified", async () => {
      const runCommand = vi.fn().mockReturnValue("");
      const hooks = deriveHooks(
        makeYaml({ postSessionCheck: { commands: ["npm test"] } }),
        { runCommand },
      );
      await hooks.postSessionCheck!(makeIssue(), "/tmp/worktrees/foo");
      expect(runCommand).toHaveBeenCalledWith("npm test", "/tmp/worktrees/foo");
    });

    it("returns failed with summary when a command throws", async () => {
      const runCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === "npx tsc") throw new Error("Type errors found");
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({ postSessionCheck: { commands: ["npm test", "npx tsc"] } }),
        { runCommand },
      );
      const result = await hooks.postSessionCheck!(makeIssue(), "/tmp/worktrees/foo");
      expect(result.passed).toBe(false);
      expect(result.summary).toContain("npx tsc");
    });
  });

  describe("printSummary", () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      spy.mockRestore();
    });

    function getOutput(): string {
      return spy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    it("uses default columns when summary is not configured", () => {
      const hooks = deriveHooks(makeYaml({ name: "Test" }));
      const issue = makeIssue({ number: 5, description: "Task", wave: 2 });
      hooks.printSummary([issue], () => "pending");
      const output = getOutput();
      expect(output).toContain("Test");
      expect(output).toContain("#5");
      expect(output).toContain("Task");
      expect(output).toContain("pending");
    });

    it("uses YAML-defined summary columns", () => {
      const hooks = deriveHooks(
        makeYaml({
          summary: {
            title: "Custom Summary",
            columns: [
              { header: "Num", width: 6, value: "issue.number", prefix: "#" },
              { header: "Slug", width: 20, value: "issue.slug" },
              { header: "Wave", width: 6, value: "issue.wave" },
              { header: "Status", width: 14, value: "status" },
            ],
          },
        }),
      );
      const issue = makeIssue({ number: 7, slug: "my-feature", wave: 3 });
      hooks.printSummary([issue], () => "succeeded");
      const output = getOutput();
      expect(output).toContain("Custom Summary");
      expect(output).toContain("#7");
      expect(output).toContain("my-feature");
      expect(output).toContain("3");
      expect(output).toContain("succeeded");
    });

    it("handles issue.description column", () => {
      const hooks = deriveHooks(
        makeYaml({
          summary: {
            title: "T",
            columns: [{ header: "Desc", width: 30, value: "issue.description" }],
          },
        }),
      );
      hooks.printSummary(
        [makeIssue({ description: "Hello world" })],
        () => "pending",
      );
      expect(getOutput()).toContain("Hello world");
    });
  });

  describe("setUpWorktree and removeWorktree", () => {
    it("setUpWorktree throws directing user to .hooks.ts", async () => {
      const hooks = deriveHooks(makeYaml());
      await expect(hooks.setUpWorktree(makeIssue())).rejects.toThrow(/\.hooks\.ts/);
    });

    it("removeWorktree throws directing user to .hooks.ts", async () => {
      const hooks = deriveHooks(makeYaml());
      await expect(hooks.removeWorktree(makeIssue())).rejects.toThrow(/\.hooks\.ts/);
    });
  });

  describe("preflightCheck and preRunSetup", () => {
    it("preflightCheck is a no-op", async () => {
      const hooks = deriveHooks(makeYaml());
      await expect(hooks.preflightCheck()).resolves.toBeUndefined();
    });

    it("preRunSetup is a no-op", async () => {
      const hooks = deriveHooks(makeYaml());
      await expect(hooks.preRunSetup()).resolves.toBeUndefined();
    });
  });
});

describe("columnAccessor", () => {
  it("rejects invalid column value paths at derivation time", () => {
    expect(() =>
      deriveHooks(
        makeYaml({
          summary: {
            title: "T",
            columns: [{ header: "Bad", width: 10, value: "invalid.path" }],
          },
        }),
      ),
    ).toThrow(/invalid.*path/i);
  });

  it("rejects completely unknown paths", () => {
    expect(() =>
      deriveHooks(
        makeYaml({
          summary: {
            title: "T",
            columns: [{ header: "Bad", width: 10, value: "foo" }],
          },
        }),
      ),
    ).toThrow();
  });
});
