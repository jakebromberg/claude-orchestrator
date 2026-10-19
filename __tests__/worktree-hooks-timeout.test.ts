import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => "origin/main"));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFileSync,
}));

import { deriveWorktreeHooks } from "../src/worktree-hooks.js";

describe("default git runner", () => {
  beforeEach(() => execFileSync.mockClear());

  it("bounds every git call well under the lease's 90 s reap window", async () => {
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

    expect(execFileSync).toHaveBeenCalledTimes(3); // rev-parse, prune, add
    for (const call of execFileSync.mock.calls as unknown as unknown[][]) {
      const opts = call[2] as { timeout?: number };
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThan(90_000);
    }
  });
});
