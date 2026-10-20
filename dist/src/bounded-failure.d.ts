/** True for an `execSync`/`spawnSync` failure caused by its `timeout` option (ETIMEDOUT, or the kill signal it sends). */
export declare function isTimeoutError(error: unknown): boolean;
/** One line for the failure of a call bounded at `boundMs`: `timed out at the <n> s bound`, else the error's non-empty lines joined with `; `. */
export declare function describeBoundedFailure(error: unknown, boundMs: number): string;
