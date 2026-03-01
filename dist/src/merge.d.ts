import type { Issue, Status, IssueMetadata, Logger } from "./types.js";
export type MergeResult = "merged" | "skipped" | "failed" | "rebase-failed";
export interface MergeOptions {
    /** If true, use --admin flag to bypass branch protection. */
    admin?: boolean;
}
export interface MergeDeps {
    getStatus: (issueNumber: number) => Status;
    getMetadata: (issueNumber: number) => IssueMetadata;
    runCommand: (cmd: string) => string;
    logger: Logger;
    getWorktreePath?: (issue: Issue) => string;
}
/**
 * Merge PRs for succeeded issues in wave order.
 * After each successful merge, rebases remaining candidates against updated main
 * (when getWorktreePath is provided). Returns a map of issue number to merge result.
 */
export declare function mergePrs(issues: Issue[], deps: MergeDeps, options?: MergeOptions): Map<number, MergeResult>;
