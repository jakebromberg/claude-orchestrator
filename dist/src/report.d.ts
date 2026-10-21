import type { Issue, Status, IssueMetadata, FailureReason, StopStage, DeathMarker } from "./types.js";
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
        /** Set when the engine stopped this issue rather than the model failing it. */
        failureReason?: FailureReason;
        stopStage?: StopStage;
        /** One entry per time the engine running this row died, oldest first; absent when it never did. Independent of `status`, `failureReason` and `stopStage`. */
        engineDeaths?: Array<{
            at: string;
        }>;
        /**
         * Whether this invocation launched a session for the row. Absent in a report
         * written before this field existed, so consumers can tell the two apart.
         */
        ran: boolean;
        /** `--session-id` of each session launched for the row (the launch, then each check-failure retry); present only when `ran`. */
        sessionIds?: string[];
    }>;
}
export declare function generateReport(configName: string, issues: Issue[], getStatus: (ref: string) => Status, getMetadata: (ref: string) => IssueMetadata, startedAt: Date, finishedAt: Date, launched: ReadonlyMap<string, readonly string[]>, getDeaths?: (ref: string) => DeathMarker[]): ReportData;
export declare function formatReport(report: ReportData): string;
