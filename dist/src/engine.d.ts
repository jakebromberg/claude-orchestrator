import type { MergeResult } from "./merge.js";
import type { Issue, OrchestratorConfig, RunOptions, Deps, Logger } from "./types.js";
export declare class Orchestrator {
    private config;
    private deps;
    private maxParallel;
    private mergePolicy;
    private adaptive;
    /** Run-scoped, so the 60 s hysteresis spans wave boundaries; created by the first launch. */
    private governor?;
    /** `claude` sessions currently running; `spawnSession` is the only writer. */
    private liveSessions;
    /**
     * Session ids this run launched, by issue ref, in launch order. A 0-byte retry
     * reuses its launch's id; each check-failure retry adds its own.
     */
    private launched;
    constructor(config: OrchestratorConfig, deps: Deps, options?: RunOptions);
    /** Rows this run launched a session for, with the `--session-id` of each launch (for the run report). */
    launchedSessions(): ReadonlyMap<string, readonly string[]>;
    /** Append `sessionId` to `issue`'s launch record. Call it at every spawn that passes `--session-id`. */
    private recordLaunch;
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
    /** The session log's content, or `undefined` when it cannot be read (killed early, or never started). */
    private readLog;
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
    /**
     * Record that `reason` (memory pressure unless stated) stopped `issue` at `stage`.
     * An unstarted issue stays `pending`; one already running is marked `failed`.
     */
    private markStopped;
    /**
     * True (and the issue is failed and stopped) when the session's own terminal
     * `result` record contains the exact line `orchestrator-stop: lease-wait`: the agent
     * gave up after repeated lease denials, which no commit or green check undoes.
     * `log` is the transcript read right after a clean exit; the last non-hook
     * `result` record is the session's (a check-failure retry appends to the same
     * file, and a hook's own `result` record may land after the real one). Any
     * other `orchestrator-stop` reason is ignored with a warning.
     */
    private sessionStopped;
    /** True (and the issue is failed and stopped) when the check did not run for memory pressure; such a result is never retried. */
    private checkStopped;
    /**
     * The one place a `claude` session is spawned for an issue. Unless `tagIssue`
     * is false, it tags the handle with the issue number. It attaches a stall
     * monitor only when `monitor` is true and the effective stall timeout
     * (`issue.stallTimeout ?? config.stallTimeout`) is above 0.
     *
     * Its exit reaction is attached to `handle.exitCode` before the caller can
     * attach one, so it runs first: on a normal exit, every continuation a call
     * site chains on `handle.exitCode` runs after the monitor has stopped, with
     * no extra microtask hop. Per-session accounting (#104) belongs in that
     * reaction, so every spawn site picks it up together; post-exit reads of the
     * session log stay at the call sites, which await them and act on the result.
     * Accounting must also run when `exitCode` rejects
     * (a `.finally`-style handler covering both paths), or a rejected exit
     * leaks a count.
     */
    private spawnSession;
    /** True (and the issue is failed and stopped) when a fresh reading says a retry may not start. */
    private retryRefused;
    /** The run's one governor, read afresh as each wave starts launching. */
    private capacityGovernor;
    private launchAndWait;
    private launchSessions;
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
