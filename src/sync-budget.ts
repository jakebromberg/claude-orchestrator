import { HEARTBEAT_MS, HEARTBEAT_STALE_MS } from "./lease.js";
import { PS_TIMEOUT_MS } from "./ps.js";

/**
 * The longest the engine may block its event loop in one synchronous stretch. A session holder is reaped
 * {@link HEARTBEAT_STALE_MS} after its last beat and beats come every {@link HEARTBEAT_MS}, and a stretch can begin right
 * after a beat, so it must end within the difference (60 s). Every bound below is a per-call timeout; the stretch is the
 * number of calls that run back to back with no yield, times the bound. `__tests__/sync-call-budget.test.ts` pins each.
 */
export const BLOCKING_BUDGET_MS = HEARTBEAT_STALE_MS - HEARTBEAT_MS;

/**
 * Bound on each synchronous gh/git call made while sessions run (the engine's `verifyPrIdentity` and
 * `producedNoCommits`, label sync's `gh`, the collision check's `git`): a hung tool fails its step instead of freezing the
 * process. PR verification runs up to {@link MAX_PR_CANDIDATES_VERIFIED} calls back to back and `producedNoCommits` can
 * follow with no yield, so (5 + 1) × 10 s fits.
 */
export const SYNC_CALL_TIMEOUT_MS = 10_000;

/**
 * Bound on each `defaultRunGit` call in the worktree hooks. `setUpWorktree` makes up to four back to back (rev-parse,
 * prune, `worktree add -b`, and on its failure `worktree add <path> <branch>`), so 4 × 12 s = 48 s.
 */
export const GIT_TIMEOUT_MS = 12_000;

/**
 * Bound on each `git` call of the lease weight lookup (`realGit`). `weightForCommands` memoizes by fact and directory,
 * so one post-check makes at most two (toplevel, origin) for one `cwd`, whatever the number of commands: 2 × 2 s.
 */
export const WEIGHT_GIT_TIMEOUT_MS = 2_000;

/**
 * Bound on `LeaseOptions.processCommand` (the default is a `ps` call): `attempt()` continues at most one dead owner's group,
 * so an acquire, which the engine's post-check makes on its event loop, blocks for one lookup at most.
 */
export const PROCESS_COMMAND_TIMEOUT_MS = PS_TIMEOUT_MS;

/**
 * How many scraped PR URLs to put to `gh pr view` before giving up. Verification is a blocking network call per
 * candidate, so an unbounded loop would let a transcript that name-drops many same-repo PRs stall a wave. The run's own
 * PR is near the newest end in every case this defends against, so a handful of the newest candidates is all that is
 * worth paying for.
 */
export const MAX_PR_CANDIDATES_VERIFIED = 5;
