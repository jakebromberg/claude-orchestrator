import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherCollisionInputs } from "../src/collision-check.js";
import { weightForCommands, type GitLookup } from "../src/lease-weights.js";
import {
  BLOCKING_BUDGET_MS,
  GIT_TIMEOUT_MS,
  MAX_PR_CANDIDATES_VERIFIED,
  PROCESS_COMMAND_TIMEOUT_MS,
  SYNC_CALL_TIMEOUT_MS,
  WEIGHT_GIT_TIMEOUT_MS,
} from "../src/sync-budget.js";

// A session holder is reaped 90 s after its last 30 s beat, and a blocking stretch can begin right after a beat.
describe("synchronous call budgets", () => {
  // The post-check's weight lookup: several commands, one cwd, so memoizedGit answers each fact once.
  const weightLookupCalls = (): number => {
    let calls = 0;
    const git: GitLookup = {
      toplevel: () => (calls++, "/work"),
      origin: () => (calls++, "git@github.com:o/r.git"),
    };
    const dir = mkdtempSync(join(tmpdir(), "co-budget-"));
    try {
      // A rule per git fact: `owner/repo` asks for the origin, an absolute path for the toplevel.
      writeFileSync(join(dir, "weights.json"), JSON.stringify([
        { pattern: "^npm", repo: "o/r", gb: 1 },
        { pattern: "^pytest", repo: "/work", gb: 2 },
      ]));
      weightForCommands(["npm test", "npm run typecheck", "pytest -q", "ruff check ."], "/work", { CO_LEASE_DIR: dir }, () => {}, git);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return calls;
  };

  it.each([
    { name: "PR verification plus the commit count", stretch: (MAX_PR_CANDIDATES_VERIFIED + 1) * SYNC_CALL_TIMEOUT_MS },
    { name: "setUpWorktree's four git calls", stretch: 4 * GIT_TIMEOUT_MS },
    { name: "the post-check weight lookup's git calls", stretch: weightLookupCalls() * WEIGHT_GIT_TIMEOUT_MS },
    // `attempt()` continues at most one dead owner's group, so one `processCommand` (a bounded `ps`) runs per acquire.
    { name: "the dead-owner check's one leader lookup", stretch: PROCESS_COMMAND_TIMEOUT_MS },
  ])("keeps $name within the heartbeat window", ({ stretch }) => {
    expect(stretch).toBeLessThanOrEqual(BLOCKING_BUDGET_MS);
  });

  it("makes at most two git calls for the weight lookup, whatever the number of commands", () => {
    expect(weightLookupCalls()).toBeLessThanOrEqual(2);
  });

  // Known gaps, described in README's "Known gaps" paragraph: each is over the budget today, so each is expected to fail.
  it.fails("keeps label sync's verification and `failed` label within the heartbeat window", () => {
    expect((MAX_PR_CANDIDATES_VERIFIED + 2) * SYNC_CALL_TIMEOUT_MS).toBeLessThanOrEqual(BLOCKING_BUDGET_MS);
  });

  it.fails("keeps label sync's verification, commit count and `succeeded` label within the heartbeat window", () => {
    expect((MAX_PR_CANDIDATES_VERIFIED + 3) * SYNC_CALL_TIMEOUT_MS).toBeLessThanOrEqual(BLOCKING_BUDGET_MS);
  });

  // Every git call gatherCollisionInputs makes with one sequential entry and `peers` peer worktrees.
  const gitCalls = (peers: number): number => {
    let total = 0;
    gatherCollisionInputs({
      runCommand: () => (total++, "abc\n"),
      existsSync: () => true,
      currentWorktree: "/wt",
      peers: Array.from({ length: peers }, (_, i) => ({ slug: `p${i}`, worktreePath: `/peer${i}` })),
      entries: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      baseBranch: "main",
    });
    return total;
  };

  it("counts the fetch, the current worktree's merge-base and two diffs per entry, and a merge-base and one diff per entry per peer", () => {
    expect(gitCalls(0)).toBe(4);
    expect(gitCalls(3) - gitCalls(2)).toBe(2);
  });

  it.fails("keeps the collision check with many peers within the heartbeat window", () => {
    const peers = 10; // the number of peers is not bounded
    expect(gitCalls(peers) * SYNC_CALL_TIMEOUT_MS).toBeLessThanOrEqual(BLOCKING_BUDGET_MS);
  });
});
