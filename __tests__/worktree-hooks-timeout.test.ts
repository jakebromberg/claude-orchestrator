import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => "origin/main"));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFileSync,
}));

import { deriveWorktreeHooks } from "../src/worktree-hooks.js";

describe("default git runner", () => {
  beforeEach(() => execFileSync.mockReset().mockImplementation(() => "origin/main"));

  it.each([
    { name: "fresh branch", addBranchFails: false, calls: 3 }, // rev-parse, prune, add -b
    { name: "existing branch", addBranchFails: true, calls: 4 }, // ... then add <path> <branch>
  ])("keeps setUpWorktree's blocking stretch within 60 s ($name)", async ({ addBranchFails, calls }) => {
    execFileSync.mockImplementation((...args: unknown[]) => {
      if (addBranchFails && Array.isArray(args[1]) && args[1].includes("-b")) throw new Error("branch exists");
      return "origin/main";
    });
    const hooks = deriveWorktreeHooks({
      reposDir: "/repos",
      existsSync: (p) => p === "/repos/r",
      mkdirSync: () => {},
    });
    const issue = {
      number: 1, slug: "s", dependsOn: [], description: "d", repo: "o/r",
      wave: 1, ref: "o/r#1", deps: [],
    };
    await hooks.setUpWorktree(issue);

    expect(execFileSync).toHaveBeenCalledTimes(calls);
    const timeouts = (execFileSync.mock.calls as unknown as unknown[][]).map(
      (call) => (call[2] as { timeout?: number }).timeout ?? Infinity,
    );
    for (const t of timeouts) expect(t).toBeGreaterThan(0);
    expect(timeouts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });
});
