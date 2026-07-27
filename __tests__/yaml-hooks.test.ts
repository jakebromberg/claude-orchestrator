import { readFileSync } from "node:fs";
import { refOf, normalizeDep } from "../src/ref.js";
import { fileURLToPath } from "node:url";
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

function makeIssue(overrides: Omit<Partial<Issue>, "deps"> & { deps?: (number | string)[] } = {}): Issue {
  const { deps: depOverride, ref: refOverride, ...rest } = overrides;
  const base = {
    number: 1,
    slug: "foo",
    wave: 1,
    dependsOn: [],
    description: "Foo issue",
    ...rest,
  };
  return {
    ...base,
    ref: refOverride ?? refOf(base),
    deps: (depOverride ?? []).map((d) => normalizeDep(d, base)),
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

  describe("getBaseBranch", () => {
    it("defaults to main when no baseBranch is configured", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.getBaseBranch?.(makeIssue())).toBe("main");
    });

    it("uses the top-level baseBranch for repos without an override", () => {
      const hooks = deriveHooks(makeYaml({ baseBranch: "develop" }));
      expect(hooks.getBaseBranch?.(makeIssue())).toBe("develop");
    });

    it("resolves the issue's repo override from the repos: map", () => {
      const hooks = deriveHooks(
        makeYaml({
          baseBranch: "main",
          repos: { "WXYC/wxyc-ios-64": { baseBranch: "master" } },
        }),
      );
      // iOS issue → master; a repo without an override → the top-level main.
      expect(
        hooks.getBaseBranch?.(makeIssue({ repo: "WXYC/wxyc-ios-64" })),
      ).toBe("master");
      expect(
        hooks.getBaseBranch?.(makeIssue({ repo: "WXYC/library-metadata-lookup" })),
      ).toBe("main");
    });

    it("falls back to defaultRepo for a repo-less issue", () => {
      const hooks = deriveHooks(
        makeYaml({
          defaultRepo: "WXYC/wxyc-ios-64",
          repos: { "WXYC/wxyc-ios-64": { baseBranch: "master" } },
        }),
      );
      expect(hooks.getBaseBranch?.(makeIssue())).toBe("master");
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

    it("expands {{CLAIM_NUMBER}} when sequentialDomains is configured", async () => {
      const readFile = vi.fn().mockReturnValue("Use: {{CLAIM_NUMBER}} migrations");
      const hooks = deriveHooks(
        makeYaml({
          promptTemplate: "/tmp/prompt.md",
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
        {
          readFile,
          yamlPath: "/abs/config.yaml",
          claimHelperPath: "/abs/cli-claim.js",
        },
      );
      const issue = makeIssue({ number: 7 });
      const result = await hooks.interpolatePrompt(issue);
      expect(result).toBe(
        "Use: node '/abs/cli-claim.js' --config '/abs/config.yaml' --issue 7 --domain migrations",
      );
    });

    it("shell-quotes paths so spaces are safe", async () => {
      const readFile = vi.fn().mockReturnValue("Cmd: {{CLAIM_NUMBER}}");
      const hooks = deriveHooks(
        makeYaml({
          promptTemplate: "/tmp/prompt.md",
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
        {
          readFile,
          yamlPath: "/Users/me/My Project/config.yaml",
          claimHelperPath: "/abs/cli-claim.js",
        },
      );
      const result = await hooks.interpolatePrompt(makeIssue({ number: 1 }));
      expect(result).toBe(
        "Cmd: node '/abs/cli-claim.js' --config '/Users/me/My Project/config.yaml' --issue 1 --domain",
      );
    });

    it("escapes embedded single quotes in paths", async () => {
      const readFile = vi.fn().mockReturnValue("Cmd: {{CLAIM_NUMBER}}");
      const hooks = deriveHooks(
        makeYaml({
          promptTemplate: "/tmp/prompt.md",
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
        {
          readFile,
          yamlPath: "/jake's/config.yaml",
          claimHelperPath: "/abs/cli-claim.js",
        },
      );
      const result = await hooks.interpolatePrompt(makeIssue({ number: 1 }));
      // Standard close-reopen escape: 'jake'\''s'
      expect(result).toBe(
        "Cmd: node '/abs/cli-claim.js' --config '/jake'\\''s/config.yaml' --issue 1 --domain",
      );
    });

    it("leaves {{CLAIM_NUMBER}} unset when sequentialDomains is absent", async () => {
      const readFile = vi.fn().mockReturnValue("Cmd: {{CLAIM_NUMBER}}");
      const hooks = deriveHooks(makeYaml({ promptTemplate: "/tmp/prompt.md" }), {
        readFile,
        yamlPath: "/abs/config.yaml",
        claimHelperPath: "/abs/cli-claim.js",
      });
      const result = await hooks.interpolatePrompt(makeIssue());
      // {{CLAIM_NUMBER}} stays as the literal placeholder when not configured
      expect(result).toBe("Cmd: {{CLAIM_NUMBER}}");
    });

    it("leaves {{CLAIM_NUMBER}} unset when yamlPath is not provided", async () => {
      const readFile = vi.fn().mockReturnValue("Cmd: {{CLAIM_NUMBER}}");
      const hooks = deriveHooks(
        makeYaml({
          promptTemplate: "/tmp/prompt.md",
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
        { readFile, claimHelperPath: "/abs/cli-claim.js" },
      );
      const result = await hooks.interpolatePrompt(makeIssue());
      expect(result).toBe("Cmd: {{CLAIM_NUMBER}}");
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

    // Regression: the default runCommand fallback used to call
    // `require("node:child_process")` inline, which throws "require is not
    // defined" when the package is loaded as ESM at runtime.
    it("default runCommand fallback works under ESM (no require)", async () => {
      const hooks = deriveHooks(
        makeYaml({ postSessionCheck: { commands: ["echo orchestrator-ok"] } }),
        // Intentionally no runCommand override — exercise the built-in path.
      );
      const result = await hooks.postSessionCheck!(makeIssue(), process.cwd());
      expect(result.passed).toBe(true);
    });
  });

  describe("postSessionCheck + sequentialPaths", () => {
    function setUpCollisionMocks(opts: {
      currentAdded?: string[];
      barAdded?: string[];
      shippedAdded?: string[];
      barExists?: boolean;
    } = {}): { runGitCommand: ReturnType<typeof vi.fn>; existsSync: ReturnType<typeof vi.fn> } {
      const runGitCommand = vi.fn((file: string, args: string[]) => {
        if (args.includes("fetch")) return "";
        if (args.includes("merge-base") && args.includes("HEAD")) return "abc123\n";
        // current worktree: abc123..HEAD
        if (args.includes("/tmp/worktrees/foo") && args.some((a) => a === "abc123..HEAD")) {
          return (opts.currentAdded ?? []).join("\n") + "\n";
        }
        // current worktree: abc123..origin/main (shipped)
        if (args.includes("/tmp/worktrees/foo") && args.some((a) => a === "abc123..origin/main")) {
          return (opts.shippedAdded ?? []).join("\n") + "\n";
        }
        // peer bar: abc123..HEAD
        if (args.includes("/tmp/worktrees/bar") && args.some((a) => a === "abc123..HEAD")) {
          return (opts.barAdded ?? []).join("\n") + "\n";
        }
        return "";
      });
      const existsSync = vi.fn((p: string) => {
        if (p === "/tmp/worktrees/bar") return opts.barExists ?? true;
        return false;
      });
      return { runGitCommand, existsSync };
    }

    it("passes when no peer worktrees exist", async () => {
      const { runGitCommand, existsSync } = setUpCollisionMocks({
        currentAdded: ["migrations/0056_a.sql"],
        barExists: false,
      });
      const hooks = deriveHooks(
        makeYaml({
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runGitCommand, existsSync },
      );
      const issue = makeIssue({ slug: "foo" });
      const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo");
      expect(result.passed).toBe(true);
    });

    it("fails when a peer worktree added a colliding key", async () => {
      const { runGitCommand, existsSync } = setUpCollisionMocks({
        currentAdded: ["migrations/0056_a.sql"],
        barAdded: ["migrations/0056_b.sql"],
      });
      const hooks = deriveHooks(
        makeYaml({
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runGitCommand, existsSync },
      );
      const result = await hooks.postSessionCheck!(
        makeIssue({ slug: "foo" }),
        "/tmp/worktrees/foo",
      );
      expect(result.passed).toBe(false);
      expect(result.summary).toContain("0056");
      expect(result.summary).toContain("bar");
      expect(result.output).toContain("0057");
    });

    it("fails when origin/main shipped a colliding key since the merge-base", async () => {
      const { runGitCommand, existsSync } = setUpCollisionMocks({
        currentAdded: ["migrations/0056_a.sql"],
        shippedAdded: ["migrations/0056_shipped.sql"],
        barExists: false,
      });
      const hooks = deriveHooks(
        makeYaml({
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runGitCommand, existsSync },
      );
      const result = await hooks.postSessionCheck!(
        makeIssue({ slug: "foo" }),
        "/tmp/worktrees/foo",
      );
      expect(result.passed).toBe(false);
      expect(result.summary).toContain("origin");
    });

    it("logs a warning and continues when a peer's git invocation throws", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runGitCommand = vi.fn((file: string, args: string[]) => {
        if (args.includes("fetch")) return "";
        if (args.includes("/tmp/worktrees/bar")) {
          throw new Error("not a git repository");
        }
        if (args.includes("merge-base") && args.includes("HEAD")) return "abc123\n";
        if (args.some((a) => a === "abc123..HEAD")) return "migrations/0056_a.sql\n";
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runGitCommand, existsSync: () => true },
      );
      const result = await hooks.postSessionCheck!(
        makeIssue({ slug: "foo" }),
        "/tmp/worktrees/foo",
      );
      expect(result.passed).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/skipping peer bar/),
      );
      warn.mockRestore();
    });

    it("short-circuits before scanning when configured commands fail", async () => {
      const runCommand = vi.fn((cmd: string) => {
        if (cmd === "npm test") throw new Error("test fail");
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({
          postSessionCheck: { commands: ["npm test"] },
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runCommand, existsSync: () => true },
      );
      const result = await hooks.postSessionCheck!(
        makeIssue({ slug: "foo" }),
        "/tmp/worktrees/foo",
      );
      expect(result.passed).toBe(false);
      expect(result.summary).toContain("npm test");
      // Collision scan should not have run — no git invocations.
      expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it("uses configured baseBranch when provided", async () => {
      const runGitCommand = vi.fn().mockReturnValue("");
      const hooks = deriveHooks(
        makeYaml({
          baseBranch: "trunk",
          sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        }),
        { runGitCommand, existsSync: () => false },
      );
      await hooks.postSessionCheck!(
        makeIssue({ slug: "foo" }),
        "/tmp/worktrees/foo",
      );
      const fetchCall = (runGitCommand.mock.calls as [string, string[]][]).find(
        ([file, args]) => file === "git" && args.includes("fetch") && args.includes("trunk"),
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![1]).toContain("/tmp/worktrees/foo");
    });
  });

  describe("postSessionCheck + repos (per-repo overrides)", () => {
    it("attaches the hook when only a repo (not top-level) defines a check", () => {
      const hooks = deriveHooks(
        makeYaml({
          issues: [
            { number: 1, slug: "foo", dependsOn: [], description: "F", repo: "WXYC/bs" },
          ],
          repos: { "WXYC/bs": { postSessionCheck: { commands: ["npm test"] } } },
        }),
      );
      expect(hooks.postSessionCheck).toBeDefined();
    });

    it("runs the issue's repo's commands, not the top-level ones", async () => {
      const runCommand = vi.fn().mockReturnValue("");
      const hooks = deriveHooks(
        makeYaml({
          postSessionCheck: { commands: ["top-level-check"] },
          issues: [
            { number: 1, slug: "ios", dependsOn: [], description: "iOS", repo: "WXYC/ios" },
            { number: 2, slug: "lml", dependsOn: [], description: "LML", repo: "WXYC/lml" },
          ],
          repos: {
            "WXYC/ios": { postSessionCheck: { commands: ["xcodebuild test"] } },
            "WXYC/lml": { postSessionCheck: { commands: ["ruff check", "pytest"] } },
          },
        }),
        { runCommand },
      );
      await hooks.postSessionCheck!(
        makeIssue({ number: 1, slug: "ios", repo: "WXYC/ios" }),
        "/tmp/worktrees/ios",
      );
      expect(runCommand).toHaveBeenCalledWith("xcodebuild test", "/tmp/worktrees/ios");
      expect(runCommand).not.toHaveBeenCalledWith("top-level-check", expect.anything());
    });

    it("falls back to the top-level commands for a repo without an override", async () => {
      const runCommand = vi.fn().mockReturnValue("");
      const hooks = deriveHooks(
        makeYaml({
          postSessionCheck: { commands: ["top-level-check"] },
          issues: [
            { number: 3, slug: "web", dependsOn: [], description: "W", repo: "WXYC/web" },
          ],
          repos: { "WXYC/web": { baseBranch: "release" } },
        }),
        { runCommand },
      );
      await hooks.postSessionCheck!(
        makeIssue({ number: 3, slug: "web", repo: "WXYC/web" }),
        "/tmp/worktrees/web",
      );
      expect(runCommand).toHaveBeenCalledWith("top-level-check", "/tmp/worktrees/web");
    });

    it("scans collisions against the issue's repo base branch (iOS master)", async () => {
      const ranges: string[] = [];
      const runGitCommand = vi.fn((_file: string, args: string[]) => {
        if (args.includes("fetch")) return "";
        if (args.includes("merge-base")) return "base1\n";
        const range = args.find((a) => a.includes(".."));
        if (range) ranges.push(range);
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({
          issues: [
            { number: 1, slug: "ios", dependsOn: [], description: "iOS", repo: "WXYC/ios" },
          ],
          repos: {
            "WXYC/ios": {
              baseBranch: "master",
              sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
            },
          },
        }),
        { runGitCommand, existsSync: () => false },
      );
      const result = await hooks.postSessionCheck!(
        makeIssue({ number: 1, slug: "ios", repo: "WXYC/ios" }),
        "/tmp/worktrees/ios",
      );
      expect(result.passed).toBe(true);
      expect(ranges).toContain("base1..origin/master");
      expect(ranges).not.toContain("base1..origin/main");
    });

    it("excludes cross-repo peers from the collision scan", async () => {
      const diffedPaths = new Set<string>();
      const runGitCommand = vi.fn((_file: string, args: string[]) => {
        if (args.includes("fetch")) return "";
        if (args.includes("merge-base")) return "base1\n";
        if (args.includes("diff")) {
          const ci = args.indexOf("-C");
          if (ci >= 0) diffedPaths.add(args[ci + 1]!);
        }
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({
          worktreeDir: "/tmp/wt",
          issues: [
            { number: 1, slug: "ios-a", dependsOn: [], description: "A", repo: "WXYC/ios" },
            { number: 2, slug: "ios-b", dependsOn: [], description: "B", repo: "WXYC/ios" },
            { number: 3, slug: "lml-x", dependsOn: [], description: "X", repo: "WXYC/lml" },
          ],
          repos: {
            "WXYC/ios": {
              baseBranch: "master",
              sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
            },
          },
        }),
        { runGitCommand, existsSync: () => true },
      );
      await hooks.postSessionCheck!(
        makeIssue({ number: 1, slug: "ios-a", repo: "WXYC/ios" }),
        "/tmp/wt/ios-a",
      );
      // Same-repo peer ios-b is scanned; cross-repo peer lml-x is not.
      expect(diffedPaths.has("/tmp/wt/ios-b")).toBe(true);
      expect(diffedPaths.has("/tmp/wt/lml-x")).toBe(false);
    });
  });

  // The package ships as ESM ("type": "module") so inline `require(...)` calls
  // crash at runtime with "require is not defined". Vitest's esbuild transform
  // hides this in unit tests by polyfilling `require`, so we guard the source
  // text directly.
  describe("ESM safety", () => {
    it("source contains no inline require() calls", () => {
      const src = readFileSync(
        fileURLToPath(new URL("../src/yaml-hooks.ts", import.meta.url)),
        "utf-8",
      );
      // Strip line comments and block comments so commentary about `require`
      // doesn't trigger the guard.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(stripped).not.toMatch(/\brequire\s*\(/);
    });
  });

  describe("labelSync", () => {
    // Regression: deriveHooks used to call `require("node:child_process")`
    // synchronously when `yaml.labelSync` was set, crashing on import under ESM.
    it("attaches onStatusChange without throwing under ESM (no require)", () => {
      const hooks = deriveHooks(
        makeYaml({
          labelSync: { prefix: "orchestrator", repo: "owner/repo" },
        }),
      );
      expect(typeof hooks.onStatusChange).toBe("function");
    });

    it("does not attach onStatusChange when no repo is resolvable", () => {
      const hooks = deriveHooks(
        makeYaml({
          labelSync: { prefix: "orchestrator" },
          issues: [{ number: 1, slug: "foo", dependsOn: [], description: "Foo" }],
        }),
      );
      expect(hooks.onStatusChange).toBeUndefined();
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

  describe("onMergeConflict hook", () => {
    it("is not attached when mergeConflictRetry is not configured", () => {
      const hooks = deriveHooks(makeYaml());
      expect(hooks.onMergeConflict).toBeUndefined();
    });

    it("is not attached when mergeConflictRetry.enabled is false", () => {
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: false } }),
      );
      expect(hooks.onMergeConflict).toBeUndefined();
    });

    it("is attached when mergeConflictRetry.enabled is true", () => {
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
      );
      expect(typeof hooks.onMergeConflict).toBe("function");
    });

    it("invokes claude with conflict files and baseBranch in the prompt", async () => {
      const commands: Array<{ cmd: string; cwd: string }> = [];
      const runCommand = vi.fn((cmd: string, cwd: string) => {
        commands.push({ cmd, cwd });
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand },
      );

      const issue = makeIssue({ number: 3, slug: "foo" });
      await hooks.onMergeConflict!(issue, ["src/foo.ts", "src/bar.ts"], "main");

      expect(commands).toHaveLength(1);
      expect(commands[0].cmd).toContain("claude");
      expect(commands[0].cmd).toContain("src/foo.ts");
      expect(commands[0].cmd).toContain("src/bar.ts");
      expect(commands[0].cmd).toContain("main");
    });

    it("runs the session in the issue's worktree", async () => {
      const commands: Array<{ cmd: string; cwd: string }> = [];
      const runCommand = vi.fn((cmd: string, cwd: string) => {
        commands.push({ cmd, cwd });
        return "";
      });
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand },
      );

      const issue = makeIssue({ number: 1, slug: "my-feat" });
      await hooks.onMergeConflict!(issue, [], "main");

      expect(commands[0].cwd).toBe("/tmp/worktrees/my-feat");
    });

    it("returns resolved:true when claude exits 0", async () => {
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand: vi.fn().mockReturnValue("") },
      );

      const result = await hooks.onMergeConflict!(makeIssue(), [], "main");

      expect(result.resolved).toBe(true);
    });

    it("returns resolved:false when claude exits non-zero", async () => {
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand: vi.fn().mockImplementation(() => { throw new Error("exit 1"); }) },
      );

      const result = await hooks.onMergeConflict!(makeIssue(), [], "main");

      expect(result.resolved).toBe(false);
      expect(result.details).toContain("exit 1");
    });

    it("includes the issue number in the prompt", async () => {
      const commands: Array<{ cmd: string; cwd: string }> = [];
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand: vi.fn((cmd, cwd) => { commands.push({ cmd, cwd }); return ""; }) },
      );

      await hooks.onMergeConflict!(makeIssue({ number: 99 }), [], "main");

      expect(commands[0].cmd).toContain("99");
    });

    it("resolves at the default Sonnet / medium tier (not Opus)", async () => {
      const commands: Array<{ cmd: string; cwd: string }> = [];
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand: vi.fn((cmd, cwd) => { commands.push({ cmd, cwd }); return ""; }) },
      );

      await hooks.onMergeConflict!(makeIssue(), [], "main");

      expect(commands[0].cmd).toContain("'--model' 'sonnet'");
      expect(commands[0].cmd).toContain("'--effort' 'medium'");
      expect(commands[0].cmd).not.toContain("opus");
    });

    it("resolves at the issue's own model / effort, with its extra dirs", async () => {
      const commands: Array<{ cmd: string; cwd: string }> = [];
      const hooks = deriveHooks(
        makeYaml({ mergeConflictRetry: { enabled: true } }),
        { runCommand: vi.fn((cmd, cwd) => { commands.push({ cmd, cwd }); return ""; }) },
      );

      await hooks.onMergeConflict!(
        makeIssue({ model: "opus", effort: "max", extraDirs: ["/repo/wxyc-shared"] }),
        [],
        "main",
      );

      expect(commands[0].cmd).toContain("'--model' 'opus'");
      expect(commands[0].cmd).toContain("'--effort' 'max'");
      expect(commands[0].cmd).toContain("'--add-dir' '/repo/wxyc-shared'");
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
