import type { Issue, Status, IssueMetadata } from "./types.js";
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
export declare function generateReport(configName: string, issues: Issue[], getStatus: (ref: string) => Status, getMetadata: (ref: string) => IssueMetadata, startedAt: Date, finishedAt: Date): ReportData;
export declare function formatReport(report: ReportData): string;
