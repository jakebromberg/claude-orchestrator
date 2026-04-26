/**
 * GitHub CLI wrapper module.
 *
 * Provides functions for interacting with GitHub issues via the `gh` CLI.
 * All functions accept a `GitHubDeps` interface for dependency injection.
 */
/** Dependencies for GitHub operations, injectable for testing. */
export interface GitHubDeps {
    runCommand: (cmd: string, options?: {
        input?: string;
    }) => string;
}
/** Options for label creation. */
export interface LabelOptions {
    color?: string;
    description?: string;
}
/** Add a label to a GitHub issue. */
export declare function addIssueLabel(repo: string, issueNumber: number, label: string, deps: GitHubDeps): void;
/** Remove a label from a GitHub issue. */
export declare function removeIssueLabel(repo: string, issueNumber: number, label: string, deps: GitHubDeps): void;
/**
 * Post a comment on a GitHub issue.
 *
 * Uses `--body-file -` with stdin pipe to avoid shell escaping issues
 * with markdown bodies containing special characters.
 */
export declare function postIssueComment(repo: string, issueNumber: number, body: string, deps: GitHubDeps): void;
/**
 * Ensure a label exists on a repository (idempotent).
 *
 * Uses `--force` so that the command succeeds whether or not the label
 * already exists.
 */
export declare function ensureLabelExists(repo: string, label: string, deps: GitHubDeps, options?: LabelOptions): void;
