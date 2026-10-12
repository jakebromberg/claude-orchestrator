/**
 * A non-blocking, mtime-aged mutex for the heavy-command lease. It makes one
 * attempt and returns; it never spins, sleeps, or throws on contention, so a
 * busy mutex reads as "not admitted this poll". (The counter store keeps its
 * own PID-reaping, spinning lock.)
 *
 * Mutual exclusion holds while every holder releases within `staleAfterMs`. A
 * holder that overruns it counts as dead, and its lock may be reaped and taken
 * while it still runs. Its late `release()` leaves the new holder's lock alone,
 * except in one remaining race: the lock is reaped and re-created between that
 * release's token check and its unlink, or that release lands between a
 * reaper's staleness check and its unlink.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { isFresh } from "./memory-pressure.js";

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
export function tryLockOnce(lockFile: string, { staleAfterMs, now = Date.now }: TryLockOptions): FileLock | null {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const lock: FileLock = {
    release() {
      try {
        if (readFileSync(lockFile, "utf8") === token) rmSync(lockFile);
      } catch {
        // Already reaped as stale; nothing to release.
      }
    },
  };
  if (create(lockFile, token)) return lock;
  if (!reapIfStale(lockFile, staleAfterMs, now)) return null;
  return create(lockFile, token) ? lock : null;
}

function create(lockFile: string, token: string): boolean {
  try {
    const fd = openSync(lockFile, "wx", 0o600);
    writeSync(fd, token);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * `undefined` when the lock file is gone. The mtime is floored to the clock's
 * millisecond resolution, so a lock written earlier in the current millisecond
 * is not mistaken for one from the future.
 */
function isStale(lockFile: string, staleAfterMs: number, now: () => number): boolean | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockFile).mtimeMs;
  } catch {
    return undefined;
  }
  return !isFresh(Math.floor(mtimeMs), now(), staleAfterMs);
}

/** True when the lock is gone (reaped by us, or released) and a create is worth retrying. */
function reapIfStale(lockFile: string, staleAfterMs: number, now: () => number): boolean {
  if (isStale(lockFile, staleAfterMs, now) === false) return false;
  // Reapers take turns through a lock of their own (this same mutex, one level
  // down, so a reaper that dies mid-reap is reaped in turn). No reaper can then
  // remove a lock that another reaper has just reaped and re-created.
  const turn = tryLockOnce(`${lockFile}.reap`, { staleAfterMs, now });
  if (!turn) return false;
  try {
    const stale = isStale(lockFile, staleAfterMs, now);
    if (stale) rmSync(lockFile, { force: true });
    return stale !== false;
  } finally {
    turn.release();
  }
}
