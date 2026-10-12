export interface TryLockOptions {
    /** A lock file whose mtime is more than this far from `now()`, before or after, is stale, whatever its contents. */
    staleAfterMs: number;
    /**
     * Wall-clock epoch milliseconds, comparable to file mtimes (default `Date.now`).
     * Any other clock (monotonic, scripted, offset) disables mutual exclusion,
     * because live locks then read as stale.
     */
    now?: () => number;
}
export interface FileLock {
    /** Removes the lock file while it still carries this lock's token; otherwise does nothing. */
    release(): void;
}
/**
 * One `O_EXCL` create; on `EEXIST`, reaps a stale lock and retries once. Returns
 * `null` while another holder has it. Throws on any other I/O error.
 */
export declare function tryLockOnce(lockFile: string, { staleAfterMs, now }: TryLockOptions): FileLock | null;
/** The mutex's freshness rule: `mtimeMs` (floored to whole milliseconds) is within `windowMs` of `now`, before or after. */
export declare const isWithinWindow: (mtimeMs: number, now: number, windowMs: number) => boolean;
