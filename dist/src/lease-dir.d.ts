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
