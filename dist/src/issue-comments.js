/**
 * Post-run summary comment module.
 *
 * Posts status comments on GitHub issues after orchestrator runs complete.
 */
/**
 * Post run summary comments on GitHub issues.
 *
 * Iterates all issues, skipping those with "pending" status, and posts
 * a markdown comment summarizing the run result. Errors per-issue are
 * non-fatal and logged as warnings.
 */
export function postRunSummaryComments(issues, config, deps) {
    for (const issue of issues) {
        const status = deps.getStatus(issue.number);
        if (status === "pending")
            continue;
        const metadata = deps.getMetadata(issue.number);
        const body = buildCommentBody(issue, status, metadata, config);
        const repo = issue.repo ?? config.repo;
        try {
            deps.runCommand(`gh issue comment ${issue.number} --repo ${repo} --body-file -`, { input: body });
        }
        catch (err) {
            deps.logger.warn(`Failed to post comment on #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
function buildCommentBody(issue, status, metadata, config) {
    const lines = [
        `### Orchestrator Run Summary`,
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| Status | **${status}** |`,
        `| Config | ${config.configName} |`,
        `| Run ID | \`${config.runId}\` |`,
    ];
    if (metadata.prUrl) {
        lines.push(`| PR | ${metadata.prUrl} |`);
    }
    if (metadata.startedAt) {
        lines.push(`| Started | ${metadata.startedAt} |`);
    }
    if (metadata.finishedAt) {
        lines.push(`| Finished | ${metadata.finishedAt} |`);
    }
    if (metadata.startedAt && metadata.finishedAt) {
        const start = new Date(metadata.startedAt).getTime();
        const end = new Date(metadata.finishedAt).getTime();
        const durationSec = Math.round((end - start) / 1000);
        const minutes = Math.floor(durationSec / 60);
        const seconds = durationSec % 60;
        const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        lines.push(`| Duration | ${durationStr} |`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=issue-comments.js.map