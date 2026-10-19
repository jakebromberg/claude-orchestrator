import { describe, it, expect } from "vitest";
import { MAX_PR_CANDIDATES_VERIFIED, SYNC_CALL_TIMEOUT_MS } from "../src/engine.js";
import { HEARTBEAT_MS, HEARTBEAT_STALE_MS } from "../src/lease.js";
import { GIT_TIMEOUT_MS } from "../src/worktree-hooks.js";

// A session holder is reaped 90 s after its last 30 s beat, and a blocking stretch can begin right after a beat.
describe("synchronous call budgets", () => {
  const blockingBudget = HEARTBEAT_STALE_MS - HEARTBEAT_MS;

  it.each([
    { name: "PR verification plus the commit count", stretch: (MAX_PR_CANDIDATES_VERIFIED + 1) * SYNC_CALL_TIMEOUT_MS },
    { name: "setUpWorktree's four git calls", stretch: 4 * GIT_TIMEOUT_MS },
  ])("keeps $name within the heartbeat window", ({ stretch }) => {
    expect(stretch).toBeLessThanOrEqual(blockingBudget);
  });
});
