import type { Issue, Status, IssueMetadata } from "./types.js";
import { repoOfRef } from "./ref.js";

/**
 * Human label for a report row. Cross-repo runs need the qualified ref to
 * disambiguate same-numbered issues; a repo-less (single-repo) ref keeps the
 * familiar `#N`. Cross-repo detection reuses `repoOfRef` — the canonical
 * `#`-based identity rule — so the report never disagrees with the DAG/store
 * layer about whether a ref is repo-qualified.
 */
function refLabel(issue: { ref: string; number: number }): string {
  return repoOfRef(issue.ref) !== undefined ? issue.ref : `#${issue.number}`;
}

export interface ReportData {
  configName: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  issues: Array<{
    /**
     * Composite issue identity (`"owner/repo#N"`, or a bare `"N"` in a
     * single-repo run). The bare `number` collides across repos, so consumers
     * that map a report row back to a `(repo, issue, PR)` — e.g. ship-dag's
     * review/merge pass after the engine implements a cross-repo wave — must
     * key on this, not on `number`.
     */
    ref: string;
    number: number;
    description: string;
    wave: number;
    status: Status;
    prUrl?: string;
    prNumber?: number;
  }>;
}

export function generateReport(
  configName: string,
  issues: Issue[],
  getStatus: (ref: string) => Status,
  getMetadata: (ref: string) => IssueMetadata,
  startedAt: Date,
  finishedAt: Date,
): ReportData {
  const durationSeconds =
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 10) / 100;

  return {
    configName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds,
    issues: issues.map((issue) => {
      const meta = getMetadata(issue.ref);
      return {
        ref: issue.ref,
        number: issue.number,
        description: issue.description,
        wave: issue.wave,
        status: getStatus(issue.ref),
        ...(meta.prUrl ? { prUrl: meta.prUrl, prNumber: meta.prNumber } : {}),
      };
    }),
  };
}

export function formatReport(report: ReportData): string {
  const lines: string[] = [];

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
  const pending = report.issues.filter(
    (i) => i.status === "pending" || i.status === "running",
  ).length;
  lines.push(`## Summary: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped, ${pending} pending`);
  lines.push("");

  // Per-issue table
  lines.push("| Issue | Description | Wave | Status | PR |");
  lines.push("|-------|-------------|------|--------|----|");
  for (const issue of report.issues) {
    const pr = issue.prUrl
      ? `[#${issue.prNumber}](${issue.prUrl})`
      : "—";
    // A bare `#N` is ambiguous in a cross-repo run (same number, two repos);
    // show the qualified ref there and keep `#N` for single-repo readability.
    const label = refLabel(issue);
    lines.push(
      `| ${label} | ${issue.description} | ${issue.wave} | ${issue.status} | ${pr} |`,
    );
  }
  lines.push("");

  // Next steps
  if (failed > 0) {
    lines.push("## Next Steps");
    lines.push("");
    lines.push("- Review failed issues and retry with `--retry-failed`");
    const failedIssues = report.issues
      .filter((i) => i.status === "failed")
      .map(refLabel);
    lines.push(`- Failed: ${failedIssues.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}
