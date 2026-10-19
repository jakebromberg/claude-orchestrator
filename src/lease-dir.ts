/**
 * The lease directory's one rule: a real directory (not a symlink) that this user owns, at mode 0700. Every writer in
 * the lease directory goes through it. No load-time side effects.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { isPid } from "./ps.js";
import { writeFileAtomic, type AtomicWriteOptions } from "./atomic-write.js";

/**
 * The lease's directory rule, applied to the lease directory and its subdirectory `name`: each is created with mode
 * 0700, one this user owns is tightened to 0700, and one that is a symlink, not a directory, or another user's throws
 * (an I/O error). A platform without uids (Windows) skips the ownership check.
 */
export function ensureOwnSubdir(dir: string, name: string): void {
  for (const d of [dir, join(dir, name)]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (!isOwnDir(st)) throw new Error(`lease: ${d} is not a directory this user owns`);
    if (st.mode & 0o077) chmodSync(d, 0o700);
  }
}

/** The lease's directory rule, given `lstat` stats: a real directory (not a symlink) this user owns. A platform without uids (Windows) skips the ownership check. */
export function isOwnDir(st: Stats): boolean {
  return st.isDirectory() && !(process.getuid && st.uid !== process.getuid());
}

/**
 * Writes `<dir>/<name>` through `writeFileAtomic` only when `dir` passes `isOwnDir`; returns whether it wrote. It never
 * creates `dir`, so a read-only caller creates nothing, and a missing, symlinked or foreign `dir` gets no write. An I/O
 * error from the write propagates.
 */
export function writeLeaseRecord(dir: string, name: string, text: string, opts?: AtomicWriteOptions): boolean {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !isOwnDir(st)) return false;
  writeFileAtomic(join(dir, name), text, opts);
  return true;
}

/**
 * Opens `path` with `flags` plus `O_NOFOLLOW | O_NONBLOCK` (a planted symlink is not followed and a planted FIFO is not
 * waited on) and returns the descriptor only for a regular file this user owns; any other kind of entry is closed and
 * reads as `undefined`. A failed open throws. The one open rule of every lease-directory read and append; the caller closes the descriptor.
 */
export function openOwnFile(path: string, flags: number, mode?: number): number | undefined {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  let owned = false;
  try {
    const st = fstatSync(fd);
    owned = st.isFile() && !(process.getuid && st.uid !== process.getuid());
  } finally {
    if (!owned) closeSync(fd);
  }
  return owned ? fd : undefined;
}

/** The text and mtime of the record `<dir>/<name>`, or `undefined` when it is missing, unreadable, or not a regular file this user owns (a symlink, FIFO, directory, foreign file). Never blocks; the caller keeps its own body validation. */
export function readLeaseRecord(dir: string, name: string): { text: string; mtimeMs: number } | undefined {
  try {
    const fd = openOwnFile(join(dir, name), constants.O_RDONLY);
    if (fd === undefined) return undefined;
    try {
      return { text: readFileSync(fd, "utf-8"), mtimeMs: fstatSync(fd).mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The text of a file the user named, which may be a symlink on purpose (dotfiles). It is opened non-blocking and read only when it is a regular file; a missing, unreadable or non-regular one throws, and a FIFO is never waited on. */
export function readRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The records of `<dir>/<sub>`, read-only: each canonical `<pid>.json` file (no leading zero; a `writeFileAtomic` temp
 * name is not one) with its text and mtime. A missing, symlinked or foreign subdirectory reads as empty, and an entry
 * that cannot be read, or is not a regular file this user owns (a symlink, FIFO, socket, directory), is skipped.
 * Creates and removes nothing.
 */
export function readRecordDir(dir: string, sub: string): { stem: number; text: string; mtimeMs: number }[] {
  const path = join(dir, sub);
  try {
    if (!isOwnDir(lstatSync(path))) return [];
    return readdirSync(path).flatMap((name) => {
      const stem = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
      const rec = isPid(stem) ? readLeaseRecord(path, name) : undefined;
      return rec ? [{ stem, ...rec }] : [];
    });
  } catch {
    return [];
  }
}
