/** Runs `ps` and returns trimmed stdout; throws on failure. Bounded (2 s unless `timeoutMs`) and stderr is discarded, so a hung `ps` cannot stall a caller and nothing writes past a `warn` seam. */
export declare function ps(args: string[], { timeoutMs }?: {
    timeoutMs?: number;
}): string;
/** One `ps -o <field>= -p <pid>` value; throws on failure. */
export declare const psField: (pid: number, field: string, opts?: {
    timeoutMs?: number;
}) => string;
/** `startPid` and its parents, nearest first, at most `depth` entries; stops at pid 1 and any failure ends the walk with what it has found. */
export declare function psAncestors(startPid: number, depth: number): number[];
/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process, and `process.kill` rejects 2^31 and above. */
export declare const isPid: (n: unknown) => boolean;
/** Whether `kill(pid, 0)` finds the process: it exists, or exists under another user (`EPERM`). */
export declare function pidAlive(pid: number): boolean;
/** `ps` `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for any other shape. */
export declare function parseElapsed(etime: string): number;
/** The one process-table scan: `ps` arguments whose output `parsePsTable` reads. Callers keep their own `ps` (and timeout), so injected dependencies stay text-in. */
export declare const PS_TABLE_ARGS: string[];
/** One row of the process table. */
export interface ProcRow {
    pid: number;
    ppid: number;
    pgid: number;
    uid: number;
    /** `ps` `stat`: state letter first, then flags. */
    stat: string;
    /** Time since the process started (`etime`), or NaN when the column cannot be read. */
    elapsedMs: number;
    command: string;
}
/** The rows of `PS_TABLE_ARGS` output; a line that is not a row is skipped. */
export declare function parsePsTable(text: string): ProcRow[];
/** `pid` and its parents through `rows`, nearest first, without pid 1. `complete` is false when a link is missing from the scan or the chain is not finished within `max` rows (a loop), so a caller that guards on the chain can fail closed. */
export declare function ancestry(rows: ProcRow[], pid: number, max: number): {
    chain: ProcRow[];
    complete: boolean;
};
