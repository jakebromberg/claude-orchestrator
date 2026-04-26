/**
 * GitHub CLI wrapper module.
 *
 * Provides functions for interacting with GitHub issues via the `gh` CLI.
 * All functions accept a `GitHubDeps` interface for dependency injection.
 */
/** Add a label to a GitHub issue. */
export function addIssueLabel(repo, issueNumber, label, deps) {
    deps.runCommand(`gh issue edit ${issueNumber} --repo ${repo} --add-label "${label}"`);
}
/** Remove a label from a GitHub issue. */
export function removeIssueLabel(repo, issueNumber, label, deps) {
    deps.runCommand(`gh issue edit ${issueNumber} --repo ${repo} --remove-label "${label}"`);
}
/**
 * Post a comment on a GitHub issue.
 *
 * Uses `--body-file -` with stdin pipe to avoid shell escaping issues
 * with markdown bodies containing special characters.
 */
export function postIssueComment(repo, issueNumber, body, deps) {
    deps.runCommand(`gh issue comment ${issueNumber} --repo ${repo} --body-file -`, { input: body });
}
/**
 * Ensure a label exists on a repository (idempotent).
 *
 * Uses `--force` so that the command succeeds whether or not the label
 * already exists.
 */
export function ensureLabelExists(repo, label, deps, options) {
    let cmd = `gh label create "${label}" --repo ${repo} --force`;
    if (options?.color) {
        cmd += ` --color ${options.color}`;
    }
    if (options?.description) {
        const escaped = options.description.replace(/'/g, "\\'");
        cmd += ` --description "${escaped}"`;
    }
    deps.runCommand(cmd);
}
//# sourceMappingURL=github.js.map