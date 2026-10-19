export interface AtomicWriteOptions {
    /** File mode for the new file; default 0600. */
    mode?: number;
    /** When set, the temp file is dated to this wall-clock time (ms) before the rename, so a reader never sees another mtime. */
    mtimeMs?: number;
    /** When true the temp file is hard-linked to `file` instead of renamed over it, so the write throws `EEXIST` when `file` exists and never replaces it. */
    exclusive?: boolean;
}
/** The pid in a `writeFileAtomic` temp name (`<file>.<pid>.<hex>.tmp`), or undefined for any other name. The one definition of the format outside the writer. */
export declare function tempOwnerPid(name: string): number | undefined;
/** Removes the `writeFileAtomic` temp files in `dir` whose writer is dead; a name with no pid, or a live writer, stays. A missing or unreadable `dir` is skipped. */
export declare function sweepDeadTemps(dir: string, isAlive: (pid: number) => boolean): void;
/**
 * Writes `text` to `file` through a temp file in the same directory and a rename, so a reader sees the old content or the new, never a torn write.
 * The temp name is unique per process and call, so writers that hold no lock never share one. The temp file is removed, best effort, on every path, and a failed removal never replaces the write's own result; the error of a failed write propagates.
 * With `exclusive` the temp file is linked instead, which fails with `EEXIST` when `file` exists.
 */
export declare function writeFileAtomic(file: string, text: string, { mode, mtimeMs, exclusive }?: AtomicWriteOptions): void;
