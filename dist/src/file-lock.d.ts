export interface TryLockOptions {
    /** A lock file older than this by mtime, or dated in the future, is stale, whatever its contents. */
    staleAfterMs: number;
    now?: () => number;
}
export interface FileLock {
    /** Removes the lock file while it still carries this lock's token; otherwise does nothing. */
    release(): void;
}
/** One `O_EXCL` create; on `EEXIST`, reaps a stale lock and retries once. Returns `null` while another holder has it. */
export declare function tryLockOnce(lockFile: string, { staleAfterMs, now }: TryLockOptions): FileLock | null;
