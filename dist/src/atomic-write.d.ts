export interface AtomicWriteOptions {
    /** File mode for the new file; default 0600. */
    mode?: number;
    /** When set, the temp file is dated to this wall-clock time (ms) before the rename, so a reader never sees another mtime. */
    mtimeMs?: number;
}
/**
 * Writes `text` to `file` through a temp file in the same directory and a rename, so a reader sees the old content or the new, never a torn write.
 * The temp name is unique per process and call, so writers that hold no lock never share one. The temp file is removed when the write or rename fails; the error propagates.
 */
export declare function writeFileAtomic(file: string, text: string, { mode, mtimeMs }?: AtomicWriteOptions): void;
