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
