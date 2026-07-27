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
     * wave rarely holds more than one. A mode-node reaching here without a command
     * is a manual gate (handled in A5b-2); until then it's a config error the
     * schema rejects, so mark it failed defensively rather than silently no-op.
     */
    private runModeNodes;
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
