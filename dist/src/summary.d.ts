import type { Issue, Status } from "./types.js";
export interface SummaryColumn {
    header: string;
    width: number;
    value: (issue: Issue, status: Status) => string;
}
export interface SummaryOptions {
    title: string;
    columns: SummaryColumn[];
    extraTotals?: (issues: Issue[]) => string;
}
/**
 * Creates a `printSummary` function matching the `OrchestratorHooks` signature.
 * Each config provides column definitions and a title; the renderer handles
 * layout, colorization, and totals.
 */
export declare function createPrintSummary(options: SummaryOptions): (issues: Issue[], getStatus: (n: number) => Status) => void;
