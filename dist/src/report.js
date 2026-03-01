export function generateReport(configName, issues, getStatus, getMetadata, startedAt, finishedAt) {
    const durationSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 10) / 100;
    return {
        configName,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationSeconds,
        issues: issues.map((issue) => {
            const meta = getMetadata(issue.number);
            return {
                number: issue.number,
                description: issue.description,
                wave: issue.wave,
                status: getStatus(issue.number),
                ...(meta.prUrl ? { prUrl: meta.prUrl, prNumber: meta.prNumber } : {}),
            };
        }),
    };
}
export function formatReport(report) {
    const lines = [];
    lines.push(`# ${report.configName} — Run Report`);
    lines.push("");
    lines.push(`- **Started**: ${report.startedAt}`);
    lines.push(`- **Finished**: ${report.finishedAt}`);
    lines.push(`- **Duration**: ${report.durationSeconds}s`);
    lines.push("");
    // Summary counts
    const succeeded = report.issues.filter((i) => i.status === "succeeded").length;
    const failed = report.issues.filter((i) => i.status === "failed").length;
    const skipped = report.issues.filter((i) => i.status === "skipped").length;
    const pending = report.issues.filter((i) => i.status === "pending" || i.status === "running").length;
    lines.push(`## Summary: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped, ${pending} pending`);
    lines.push("");
    // Per-issue table
    lines.push("| Issue | Description | Wave | Status | PR |");
    lines.push("|-------|-------------|------|--------|----|");
    for (const issue of report.issues) {
        const pr = issue.prUrl
            ? `[#${issue.prNumber}](${issue.prUrl})`
            : "—";
        lines.push(`| #${issue.number} | ${issue.description} | ${issue.wave} | ${issue.status} | ${pr} |`);
    }
    lines.push("");
    // Next steps
    if (failed > 0) {
        lines.push("## Next Steps");
        lines.push("");
        lines.push("- Review failed issues and retry with `--retry-failed`");
        const failedIssues = report.issues
            .filter((i) => i.status === "failed")
            .map((i) => `#${i.number}`);
        lines.push(`- Failed: ${failedIssues.join(", ")}`);
        lines.push("");
    }
    return lines.join("\n");
}
//# sourceMappingURL=report.js.map