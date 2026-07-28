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
    private refreshMetadata;
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
