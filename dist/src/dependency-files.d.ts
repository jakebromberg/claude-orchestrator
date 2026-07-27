import type { Issue, IssueMetadata } from "./types.js";
/**
 * Collect files changed by upstream dependency issues.
 * Walks the issue's deps array and gathers filesChanged from their metadata.
 * Returns a deduplicated, sorted list of file paths.
 */
export declare function getDependencyFiles(issue: Issue, allIssues: Issue[], getMetadata: (issueNumber: number) => IssueMetadata): string[];
