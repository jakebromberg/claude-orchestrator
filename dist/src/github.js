/**
 * GitHub CLI wrapper module.
 *
 * Provides functions for interacting with GitHub issues via the `gh` CLI.
 * All functions accept a `GitHubDeps` interface for dependency injection.
 */
import { shellQuote } from "./shell-quote.js";
/** Add a label to a GitHub issue. */
export function addIssueLabel(repo, issueNumber, label, deps) {
    deps.runCommand(`gh issue edit ${issueNumber} --repo ${shellQuote(repo)} --add-label ${shellQuote(label)}`);
}
/** Remove a label from a GitHub issue. */
export function removeIssueLabel(repo, issueNumber, label, deps) {
    deps.runCommand(`gh issue edit ${issueNumber} --repo ${shellQuote(repo)} --remove-label ${shellQuote(label)}`);
}
/**
 * Post a comment on a GitHub issue.
 *
 * Uses `--body-file -` with stdin pipe to avoid shell escaping issues
 * with markdown bodies containing special characters.
 */
export function postIssueComment(repo, issueNumber, body, deps) {
    deps.runCommand(`gh issue comment ${issueNumber} --repo ${shellQuote(repo)} --body-file -`, { input: body });
}
/**
 * Ensure a label exists on a repository (idempotent).
 *
 * Uses `--force` so that the command succeeds whether or not the label
 * already exists.
 */
export function ensureLabelExists(repo, label, deps, options) {
    let cmd = `gh label create ${shellQuote(label)} --repo ${shellQuote(repo)} --force`;
    if (options?.color) {
        cmd += ` --color ${shellQuote(options.color)}`;
    }
    if (options?.description) {
        cmd += ` --description ${shellQuote(options.description)}`;
    }
    deps.runCommand(cmd);
}
//# sourceMappingURL=github.js.map