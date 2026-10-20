import { describe, it, expect, vi, beforeEach } from "vitest";

const execSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execSync,
  execFileSync,
}));

import { SYNC_CALL_TIMEOUT_MS } from "../src/worktree-hooks.js";
import { deriveHooks } from "../src/yaml-hooks.js";
import type { Issue } from "../src/types.js";
import type { YamlConfig } from "../src/yaml-types.js";

const issue = { number: 7, slug: "foo", ref: "7", wave: 1, dependsOn: [], deps: [], description: "d" } as Issue;
const peer = { number: 8, slug: "bar", dependsOn: [], description: "p" };

const yaml = (over: Partial<YamlConfig>): YamlConfig => ({
  name: "t", configDir: "/tmp/c", worktreeDir: "/tmp/worktrees", projectRoot: "/tmp/p", stallTimeout: 300,
  issues: [issue, peer],
  ...over,
});

const timeoutOf = (call: unknown[] | undefined): unknown => (call?.at(-1) as { timeout?: number } | undefined)?.timeout;

describe("synchronous calls during a wave", () => {
  beforeEach(() => {
    execSync.mockReset().mockReturnValue("");
    execFileSync.mockReset().mockReturnValue("");
  });

  it("bounds label sync's gh call, and keeps the status when it hangs", async () => {
    execSync.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), { code: "ETIMEDOUT" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hooks = deriveHooks(yaml({ labelSync: { prefix: "orchestrator", repo: "o/r" } }));
    await expect(Promise.resolve(hooks.onStatusChange!(issue, "pending", "running"))).resolves.not.toThrow();
    expect(execSync).toHaveBeenCalled();
    for (const call of execSync.mock.calls) expect(timeoutOf(call)).toBe(SYNC_CALL_TIMEOUT_MS);
    warn.mockRestore();
  });

  it.each([
    { fetch: "returns", fetchTimesOut: false },
    { fetch: "times out", fetchTimesOut: true },
  ])("bounds the collision check's default git runner, and passes the check when git fetch $fetch", async ({ fetchTimesOut }) => {
    execFileSync.mockImplementation((_file: unknown, args: unknown) => {
      if (fetchTimesOut && (args as string[]).includes("fetch")) {
        throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      return "";
    });
    const hooks = deriveHooks(yaml({
      sequentialPaths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      postSessionCheck: undefined,
    }));
    const result = await hooks.postSessionCheck!(issue, "/tmp/worktrees/foo");
    expect(result.passed).toBe(true);
    expect(execFileSync.mock.calls.some(([, args]) => (args as string[]).includes("fetch"))).toBe(true);
    for (const call of execFileSync.mock.calls) expect(timeoutOf(call)).toBe(SYNC_CALL_TIMEOUT_MS);
  });
});
