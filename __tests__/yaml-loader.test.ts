import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadYamlConfig } from "../src/yaml-loader.js";

const MINIMAL_YAML = `
name: "Test Orchestrator"
configDir: "./config"
worktreeDir: "./worktrees"
projectRoot: "."
stallTimeout: 300
issues:
  - number: 1
    slug: alpha
    dependsOn: []
    description: "Alpha feature"
  - number: 2
    slug: beta
    dependsOn: [1]
    description: "Beta feature"
`;

const FULL_YAML = `
name: "Full Config"
configDir: "./cfg"
worktreeDir: "./wt"
projectRoot: "../project"
stallTimeout: 120
allowedTools: [Bash, Read, Write]
branchPrefix: "feat/"
retryableStatuses: [failed, interrupted]
promptTemplate: "./prompt.md"
claudeArgs:
  - "--add-dir"
  - "{{projectRoot}}"
postSessionCheck:
  commands: ["npm test"]
  cwd: "scripts"
summary:
  title: "Feature Progress"
  columns:
    - { header: "Issue", width: 6, value: "issue.number", prefix: "#" }
    - { header: "Status", width: 14, value: "status" }
issues:
  - number: 10
    slug: widget
    dependsOn: []
    description: "Widget feature"
`;

const INVALID_YAML = `
name: ""
configDir: "./config"
worktreeDir: "./worktrees"
projectRoot: "."
stallTimeout: 300
issues: []
`;

describe("loadYamlConfig", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readFileSpy: any;

  beforeEach(() => {
    readFileSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  it("loads and validates a minimal YAML config", async () => {
    readFileSpy.mockReturnValue(MINIMAL_YAML);

    const config = await loadYamlConfig("/projects/test/orchestrator.yaml");

    expect(config.name).toBe("Test Orchestrator");
    expect(config.stallTimeout).toBe(300);
    expect(config.issues).toHaveLength(2);
    expect(config.issues[0].wave).toBe(1);
    expect(config.issues[1].wave).toBe(2);
    expect(readFileSpy).toHaveBeenCalledWith("/projects/test/orchestrator.yaml", "utf-8");
  });

  it("resolves relative paths against the YAML file directory", async () => {
    readFileSpy.mockReturnValue(MINIMAL_YAML);

    const config = await loadYamlConfig("/projects/test/orchestrator.yaml");

    expect(config.configDir).toBe("/projects/test/config");
    expect(config.worktreeDir).toBe("/projects/test/worktrees");
    expect(config.projectRoot).toBe("/projects/test");
  });

  it("loads a full YAML config with all optional fields", async () => {
    readFileSpy.mockReturnValue(FULL_YAML);

    const config = await loadYamlConfig("/home/user/orch.yaml");

    expect(config.name).toBe("Full Config");
    expect(config.allowedTools).toEqual(["Bash", "Read", "Write"]);
    expect(config.issues[0].number).toBe(10);
    expect(config.hooks.getBranchName(config.issues[0])).toBe("feat/widget");
    expect(config.hooks.isRetryableStatus("interrupted")).toBe(true);
    expect(config.hooks.postSessionCheck).toBeDefined();
  });

  it("throws on invalid YAML schema (empty name)", async () => {
    readFileSpy.mockReturnValue(INVALID_YAML);

    await expect(
      loadYamlConfig("/projects/test/bad.yaml"),
    ).rejects.toThrow();
  });

  it("throws on malformed YAML", async () => {
    readFileSpy.mockReturnValue("{{{{not valid yaml");

    await expect(
      loadYamlConfig("/projects/test/bad.yaml"),
    ).rejects.toThrow();
  });

  it("merges hook overrides from .hooks.ts", async () => {
    readFileSpy.mockReturnValue(MINIMAL_YAML);

    const customSetUp = vi.fn(async () => {});
    const config = await loadYamlConfig("/projects/test/orch.yaml", {
      hooksOverride: { setUpWorktree: customSetUp },
    });

    expect(config.hooks.setUpWorktree).toBe(customSetUp);
    // Non-overridden hooks still work
    expect(config.hooks.getBranchName(config.issues[0])).toBe("orchestrator/alpha");
  });

  it("override hooks take precedence over derived hooks", async () => {
    readFileSpy.mockReturnValue(MINIMAL_YAML);

    const customGetBranch = vi.fn(() => "custom/branch");
    const config = await loadYamlConfig("/projects/test/orch.yaml", {
      hooksOverride: { getBranchName: customGetBranch },
    });

    expect(config.hooks.getBranchName(config.issues[0])).toBe("custom/branch");
  });

  it("passes through allowedTools", async () => {
    readFileSpy.mockReturnValue(FULL_YAML);

    const config = await loadYamlConfig("/home/user/orch.yaml");
    expect(config.allowedTools).toEqual(["Bash", "Read", "Write"]);
  });

  it("flows the per-issue serial flag through to wave assignment", async () => {
    readFileSpy.mockReturnValue(`
name: "Serial Test"
configDir: "./cfg"
worktreeDir: "./wt"
projectRoot: "."
stallTimeout: 300
issues:
  - number: 1
    slug: parallel-a
    dependsOn: []
    description: "Parallel A"
  - number: 2
    slug: parallel-b
    dependsOn: []
    description: "Parallel B"
  - number: 3
    slug: migration-a
    dependsOn: []
    description: "Migration A"
    serial: true
  - number: 4
    slug: migration-b
    dependsOn: []
    description: "Migration B"
    serial: true
`);

    const config = await loadYamlConfig("/projects/test/orch.yaml");
    const byNumber = new Map(config.issues.map((i) => [i.number, i]));

    expect(byNumber.get(1)!.wave).toBe(1);
    expect(byNumber.get(2)!.wave).toBe(1);
    expect(byNumber.get(3)!.wave).toBe(2);
    expect(byNumber.get(4)!.wave).toBe(3);
    expect(byNumber.get(3)!.serial).toBe(true);
  });

  it("flows sequentialPaths and baseBranch through to a working postSessionCheck", async () => {
    readFileSpy.mockReturnValue(`
name: "Sequential Test"
configDir: "./cfg"
worktreeDir: "./wt"
projectRoot: "."
stallTimeout: 300
baseBranch: trunk
sequentialPaths:
  - dir: migrations
    pattern: "(\\\\d{4})_.*\\\\.sql"
issues:
  - number: 1
    slug: foo
    dependsOn: []
    description: "Foo"
  - number: 2
    slug: bar
    dependsOn: []
    description: "Bar"
`);

    const config = await loadYamlConfig("/projects/test/orch.yaml");
    expect(config.hooks.postSessionCheck).toBeDefined();
  });

  it("expands {{CLAIM_NUMBER}} through interpolatePrompt with the loader's yamlPath", async () => {
    // Write real files to a tempdir — yaml-hooks.ts uses a dynamic
    // `await import("node:fs")` to read the prompt template, which dodges
    // the readFileSpy. Real I/O is the cleanest workaround.
    readFileSpy.mockRestore();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-loader-claim-"));
    try {
      const yamlPath = path.join(tmpDir, "orch.yaml");
      const promptPath = path.join(tmpDir, "prompt.md");
      fs.writeFileSync(
        yamlPath,
        `
name: "Claim Test"
configDir: "./cfg"
worktreeDir: "./wt"
projectRoot: "."
stallTimeout: 300
promptTemplate: "./prompt.md"
sequentialDomains:
  migrations:
    paths:
      - dir: migrations
        pattern: "(\\\\d{4})_.*\\\\.sql"
    width: 4
issues:
  - number: 7
    slug: add-orders
    dependsOn: []
    description: "Add orders table"
`,
      );
      fs.writeFileSync(promptPath, "Claim cmd: {{CLAIM_NUMBER}} migrations");

      const config = await loadYamlConfig(yamlPath);
      const issue = config.issues[0]!;
      const prompt = await config.hooks.interpolatePrompt(issue);

      // The loader resolves yamlPath to an absolute path and threads it into
      // deriveHooks; the helper path is pkg-install-relative (cli-claim.js
      // sibling of yaml-hooks.js), and both are shell-quoted.
      expect(prompt).toContain(`--config '${yamlPath}'`);
      expect(prompt).toContain("--issue 7");
      expect(prompt).toMatch(/--domain migrations$/);
      expect(prompt).toContain("cli-claim.js");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a sequentialPaths pattern with no capture group at load time", async () => {
    readFileSpy.mockReturnValue(`
name: "Bad pattern"
configDir: "./cfg"
worktreeDir: "./wt"
projectRoot: "."
stallTimeout: 300
sequentialPaths:
  - dir: migrations
    pattern: "\\\\d{4}_.*\\\\.sql"
issues:
  - number: 1
    slug: foo
    dependsOn: []
    description: "Foo"
`);

    await expect(
      loadYamlConfig("/projects/test/orch.yaml"),
    ).rejects.toThrow(/capture group/i);
  });

  it("computes wave assignments via validateConfig", async () => {
    readFileSpy.mockReturnValue(MINIMAL_YAML);

    const config = await loadYamlConfig("/projects/test/orch.yaml");

    // Issue 1 has no deps → wave 1, Issue 2 depends on 1 → wave 2
    expect(config.issues[0].wave).toBe(1);
    expect(config.issues[0].deps).toEqual([]);
    expect(config.issues[1].wave).toBe(2);
    expect(config.issues[1].deps).toEqual([1]);
  });
});
