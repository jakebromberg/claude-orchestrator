import type { Issue, Status, IssueMetadata } from "./types.js";
export interface ReportData {
    configName: string;
    startedAt: string;
    finishedAt: string;
    durationSeconds: number;
    issues: Array<{
        number: number;
        description: string;
        wave: number;
        status: Status;
        prUrl?: string;
        prNumber?: number;
    }>;
}
export declare function generateReport(configName: string, issues: Issue[], getStatus: (n: number) => Status, getMetadata: (n: number) => IssueMetadata, startedAt: Date, finishedAt: Date): ReportData;
export declare function formatReport(report: ReportData): string;
