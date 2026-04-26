/**
 * Post-run summary comment module.
 *
 * Posts status comments on GitHub issues after orchestrator runs complete.
 */
import type { Issue, Status, IssueMetadata, Logger } from "./types.js";
/** Configuration for posting run summary comments. */
export interface IssueCommentConfig {
    repo: string;
    runId: string;
    configName: string;
}
/** Dependencies for posting run summary comments, injectable for testing. */
export interface IssueCommentDeps {
    runCommand: (cmd: string, options?: {
        input?: string;
    }) => string;
    getStatus: (issueNumber: number) => Status;
    getMetadata: (issueNumber: number) => IssueMetadata;
    logger: Logger;
}
/**
 * Post run summary comments on GitHub issues.
 *
 * Iterates all issues, skipping those with "pending" status, and posts
 * a markdown comment summarizing the run result. Errors per-issue are
 * non-fatal and logged as warnings.
 */
export declare function postRunSummaryComments(issues: Issue[], config: IssueCommentConfig, deps: IssueCommentDeps): void;
