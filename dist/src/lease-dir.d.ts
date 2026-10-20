/**
 * The lease directory's one rule: a real directory (not a symlink) that this user owns, at mode 0700. Every writer in
 * the lease directory goes through it. No load-time side effects.
 */
import { type Stats } from "node:fs";
import { type AtomicWriteOptions } from "./atomic-write.js";
/**
 * The lease's directory rule, applied to the lease directory and its subdirectory `name`: each is created with mode
 * 0700, one this user owns is tightened to 0700, and one that is a symlink, not a directory, or another user's throws
 * (an I/O error). A platform without uids (Windows) skips the ownership check.
 */
export declare function ensureOwnSubdir(dir: string, name: string): void;
/** The lease's directory rule, given `lstat` stats: a real directory (not a symlink) this user owns. A platform without uids (Windows) skips the ownership check. */
export declare function isOwnDir(st: Stats): boolean;
/**
 * Writes `<dir>/<name>` through `writeFileAtomic` only when `dir` passes `isOwnDir`; returns whether it wrote. It never
 * creates `dir`, so a read-only caller creates nothing, and a missing, symlinked or foreign `dir` gets no write. An I/O
 * error from the write propagates.
 */
export declare function writeLeaseRecord(dir: string, name: string, text: string, opts?: AtomicWriteOptions): boolean;
/**
 * Opens `path` with `flags` plus `O_NOFOLLOW | O_NONBLOCK` (a planted symlink is not followed and a planted FIFO is not
 * waited on; a UNIX socket cannot be opened and is refused too) and returns the descriptor and its stats only for a regular file this user owns; a symlink or any other kind
 * of entry reads as `undefined` (a descriptor it opened is closed). Any other failed open throws. The one open rule of
 * every lease-directory read and append; the caller closes the descriptor.
 */
export declare function openOwnFile(path: string, flags: number, mode?: number): {
    fd: number;
    st: Stats;
} | undefined;
/**
 * The text and mtime of `path` through `openOwnFile`, or `undefined` when it is not a regular file this user owns (a
 * symlink, FIFO, directory, foreign file). Never blocks. A missing file or any other I/O error throws, for a caller that
 * tells them apart (the lease's holder and ticket scans).
 */
export declare function readOwnFile(path: string): {
    text: string;
    mtimeMs: number;
} | undefined;
/** The text and mtime of the record `<dir>/<name>`, or `undefined` when it is missing, unreadable, or not a regular file this user owns (a symlink, FIFO, directory, foreign file). Never blocks; the caller keeps its own body validation. */
export declare function readLeaseRecord(dir: string, name: string): {
    text: string;
    mtimeMs: number;
} | undefined;
/** The text of a file the user named, which may be a symlink on purpose (dotfiles). It is opened non-blocking and read only when it is a regular file; a missing, unreadable or non-regular one throws, and a FIFO is never waited on. */
export declare function readRegularFile(path: string): string;
/**
 * The records of `<dir>/<sub>`, read-only: each canonical `<pid>.json` file (no leading zero; a `writeFileAtomic` temp
 * name is not one) with its text and mtime. A missing, symlinked or foreign subdirectory reads as empty, and an entry
 * that cannot be read, or is not a regular file this user owns (a symlink, FIFO, socket, directory), is skipped.
 * Creates and removes nothing.
 */
export declare function readRecordDir(dir: string, sub: string): {
    stem: number;
    text: string;
    mtimeMs: number;
}[];
