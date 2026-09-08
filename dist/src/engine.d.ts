import type { MergeResult } from "./merge.js";
import type { Issue, OrchestratorConfig, RunOptions, Deps, Logger } from "./types.js";
export declare class Orchestrator {
    private config;
    private deps;
    private maxParallel;
    private mergePolicy;
    constructor(config: OrchestratorConfig, deps: Deps, options?: RunOptions);
    checkPrerequisites(): void;
    resetStaleStatuses(): Promise<void>;
    handleInterrupt(): Promise<void>;
    runWave(wave: number): Promise<void>;
    runAllWaves(): Promise<void>;
    /**
     * After a full run, a held cutover gate is left `pending` and its dependents
     * `skipped` while the process exits normally — so without an aggregate signal
     * a run that quietly skipped half the DAG reads as a clean success. Surface it.
     */
    private reportHeldGates;
    runSpecific(issueNumbers: number[]): Promise<void>;
    retryFailed(): Promise<void>;
    cleanup(): Promise<void>;
    private setStatus;
    private prepareIssues;
    /**
     * Prepare a set of issues and run them: Claude sessions in parallel via the
     * process pool, then the wave's mode-nodes (deploy/publish/gate). Mode-nodes
     * run after the Claude work because within a wave they never depend on it —
     * dependents always land in a later wave — so ordering is free, and running
     * flow-control/deploy nodes last reads naturally.
     */
    private dispatchIssues;
    /**
     * Execute mode-nodes: run each command node's `command` (exit 0 → succeeded,
     * non-zero → failed). Sequential — deploy/publish steps shouldn't race, and a
     * wave rarely holds more than one. A command-less mode-node is a manual gate;
     * reaching here means its cutover was already confirmed in `prepareIssues`
     * (an unconfirmed gate is held and never dispatched), so mark it succeeded.
     */
    private runModeNodes;
    /**
     * Ask the `confirmCutover` hook whether a gated issue may be released. Absent
     * hook → not confirmed (hold), the conservative default for a cross-repo run.
     * A throwing hook is also treated as "not confirmed".
     */
    private confirmCutover;
    private checkDeps;
    /**
     * Re-derive an already-succeeded issue's PR metadata from its session log, so
     * a re-run reports the same PR the original run opened.
     *
     * Existing metadata is never cleared when the log yields nothing: the log may
     * be truncated, rotated, or from a different run, and — since nothing reaches
     * the store without passing {@link verifyPrIdentity} — what is already there
     * was true when it was written. That also covers the benign case where the PR
     * has since merged and no longer verifies as open.
     */
    private refreshMetadata;
    /**
     * Scrape the session log for the PR this run opened and record it — but only
     * once it has been proven to be this run's PR.
     *
     * Two independent narrowings stand between a string in a log and a `prUrl` in
     * the store, because a wrong value here is not merely a reporting error:
     * `mergePrs` feeds `metadata.prUrl` straight to `gh pr merge`, so under any
     * `mergePolicy` other than `"none"` a foreign URL is a merge of someone
     * else's branch.
     *
     *  1. `extractPrUrl` only considers URLs under the issue's own `owner/repo`.
     *  2. {@link verifyPrIdentity} asks GitHub whether that PR is open on this
     *     run's branch.
     *
     * A candidate that fails either is dropped with a warning rather than
     * recorded, and existing metadata is left untouched.
     */
    private recordPrFromLog;
    private recordPrFromLogUnguarded;
    /**
     * Confirm a scraped PR URL identifies this run's own PR.
     *
     * Presence in a log proves nothing (see `pr-tracker.ts`); identity does. The
     * PR must exist, still be open, and have this run's branch as its head — a
     * sibling repo's PR quoted in a CLAUDE.md, an already-merged PR someone cited
     * by number, and a stale URL from an earlier attempt each fail at least one
     * of those.
     *
     * Anything that is not an affirmative "yes" — a `gh` failure, unparseable
     * output, a deleted PR — counts as unverified. Failing closed is the point:
     * the store is what `mergePrs` acts on.
     */
    /**
     * Bound for the synchronous shell-outs the post-check path makes.
     *
     * `deps.runCommand` is `execSync`, so an unbounded `gh`/`git` blocks the
     * event loop — and with it every other session's StallMonitor and log-size
     * polling. Neither of these calls is covered by a stall monitor, so a `gh`
     * that hangs on network backoff or an unanswerable auth prompt would deadlock
     * the whole run. Same reasoning, and the same source, as `runModeNodes`.
     * A stall timeout of 0 means unbounded there, and means unbounded here.
     */
    private commandTimeoutFor;
    private verifyPrIdentity;
    /**
     * Positive evidence that a session committed nothing on its branch.
     *
     * A `claude -p` session that ends its turn mid-task exits 0, so the child's
     * exit code reports "the process finished", not "the work landed". Both
     * observed false greens looked exactly like that: a clean exit over a
     * worktree whose branch held zero commits, the work complete but uncommitted.
     * One `git rev-list --count` against the issue's base branch separates the
     * two cases.
     *
     * Deliberately asymmetric. Only a well-formed count of zero is treated as
     * proof that nothing was produced. A throw or unparseable output means the
     * check could not run at all (worktree already removed, no `origin/<base>`
     * ref, git unavailable) — that is not evidence the session failed, so it
     * warns and lets the run's own result stand rather than converting an
     * unrelated git problem into a wall of false reds.
     */
    private producedNoCommits;
    /**
     * Record the outcome of a session that exited 0 and passed its post-session
     * check. `succeeded` is contingent on the run having actually produced a
     * commit — see {@link producedNoCommits} for why a clean exit is not enough.
     */
    private recordCleanExit;
    private launchAndWait;
    private isZeroByteLog;
    private runPostSessionCheck;
    private handleCheckResultWithRetry;
}
/**
 * Clean up worktrees and remote branches for issues that were successfully merged.
 * Failures are non-fatal (logged as warnings) so one failed cleanup doesn't block others.
 */
export declare function cleanUpMergedIssues(issues: Issue[], mergeResults: Map<string, MergeResult>, deps: {
    removeWorktree: (issue: Issue) => Promise<void>;
    runCommand: (cmd: string) => string;
    logger: Logger;
    getBranchName: (issue: Issue) => string;
}): Promise<void>;
