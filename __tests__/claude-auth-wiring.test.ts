import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ExecOptions = { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv };

// yaml-hooks reaches child_process through named imports, so the module has to
// be mocked (a vi.spyOn on the namespace wouldn't rebind the named binding).
const { execSync, execFileSync } = vi.hoisted(() => ({
  execSync: vi.fn<(cmd: string, options?: ExecOptions) => string>(() => ""),
  execFileSync: vi.fn<(file: string, args?: string[]) => string>(() => ""),
}));
vi.mock("node:child_process", () => ({ execSync, execFileSync }));

const { deriveHooks } = await import("../src/yaml-hooks.js");
import type { YamlConfig } from "../src/yaml-types.js";

/** Minimal config with the Claude-driven merge-conflict resolver enabled. */
function configWithConflictRetry(): YamlConfig {
  return {
    name: "test",
    configDir: "/tmp/cfg",
    worktreeDir: "/tmp/wt",
    projectRoot: "/tmp",
    stallTimeout: 600,
    promptTemplate: "prompt.md",
    branchPrefix: "orchestrator/",
    mergeConflictRetry: { enabled: true },
    issues: [{ number: 1, slug: "feature", dependsOn: [], description: "d" }],
  } as unknown as YamlConfig;
}

describe("onMergeConflict default command runner", () => {
  const saved = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    execSync.mockClear();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.CLAUDE_ORCHESTRATOR_USE_API_KEY;
  });

  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("runs claude without the API credentials that would bill API credits", async () => {
    const hooks = deriveHooks(configWithConflictRetry(), {});

    await hooks.onMergeConflict!(
      { number: 1, slug: "feature", ref: "1", dependsOn: [], description: "d" } as never,
      ["src/a.ts"],
      "main",
    );

    expect(execSync).toHaveBeenCalledTimes(1);
    const [cmd, opts] = execSync.mock.calls[0];
    expect(cmd).toMatch(/^claude -p /);
    expect(opts?.env).toBeDefined();
    expect(opts!.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts!.env!.PATH).toBe(process.env.PATH);
  });

  it("keeps credentials when API-key billing is opted in", async () => {
    process.env.CLAUDE_ORCHESTRATOR_USE_API_KEY = "1";
    const hooks = deriveHooks(configWithConflictRetry(), {});

    await hooks.onMergeConflict!(
      { number: 1, slug: "feature", ref: "1", dependsOn: [], description: "d" } as never,
      ["src/a.ts"],
      "main",
    );

    const [, opts] = execSync.mock.calls[0];
    expect(opts!.env!.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    delete process.env.CLAUDE_ORCHESTRATOR_USE_API_KEY;
  });
});
