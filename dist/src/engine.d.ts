import type { MergeResult } from "./merge.js";
import type { Issue, OrchestratorConfig, RunOptions, Deps, Logger } from "./types.js";
export declare class Orchestrator {
    private config;
    private deps;
    private maxParallel;
    private mergePolicy;
    constructor(config: OrchestratorConfig, deps: Deps, options?: RunOptions);
    checkPrerequisites(): void;
    resetStaleStatuses(): void;
    handleInterrupt(): void;
    runWave(wave: number): Promise<void>;
    runAllWaves(): Promise<void>;
    runSpecific(issueNumbers: number[]): Promise<void>;
    retryFailed(): Promise<void>;
    cleanup(): Promise<void>;
    private prepareIssues;
    private checkDeps;
    private refreshMetadata;
    private launchAndWait;
    private isZeroByteLog;
    private runPostSessionCheck;
}
/**
 * Clean up worktrees and remote branches for issues that were successfully merged.
 * Failures are non-fatal (logged as warnings) so one failed cleanup doesn't block others.
 */
export declare function cleanUpMergedIssues(issues: Issue[], mergeResults: Map<number, MergeResult>, deps: {
    removeWorktree: (issue: Issue) => Promise<void>;
    runCommand: (cmd: string) => string;
    logger: Logger;
    getBranchName: (issue: Issue) => string;
}): Promise<void>;
