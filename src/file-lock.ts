/**
 * A non-blocking, mtime-aged mutex for the heavy-command lease. It makes one
 * attempt and returns; it never spins, sleeps, or throws on contention, so a
 * busy mutex reads as "not admitted this poll". (The counter store keeps its
 * own PID-reaping, spinning lock.)
 */
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface TryLockOptions {
  /** A lock file older than this by mtime is stale, whatever its contents. */
  staleAfterMs: number;
  now?: () => number;
}

export interface FileLock {
  release(): void;
}

/** One `O_EXCL` create; on `EEXIST`, reaps a stale lock and retries once. Returns `null` while another holder has it. */
export function tryLockOnce(lockFile: string, { staleAfterMs, now = Date.now }: TryLockOptions): FileLock | null {
  const lock: FileLock = {
    release() {
      try {
        unlinkSync(lockFile);
      } catch {
        // Already reaped as stale; nothing to release.
      }
    },
  };
  if (create(lockFile)) return lock;
  if (!reapIfStale(lockFile, staleAfterMs, now)) return null;
  return create(lockFile) ? lock : null;
}

function create(lockFile: string): boolean {
  try {
    const fd = openSync(lockFile, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** True when the lock is gone (reaped by us or by a racing reaper) and a create is worth retrying. */
function reapIfStale(lockFile: string, staleAfterMs: number, now: () => number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockFile).mtimeMs;
  } catch {
    return true;
  }
  if (now() - mtimeMs <= staleAfterMs) return false;
  // A rename to a unique name lets exactly one reaper win; the loser sees ENOENT.
  const doomed = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockFile, doomed);
  } catch {
    return true;
  }
  if (now() - statSync(doomed).mtimeMs <= staleAfterMs) {
    // Another reaper replaced the stale lock between our stat and rename; put the live one back.
    try {
      linkSync(doomed, lockFile);
    } catch {
      // A third party already re-created it.
    }
    unlinkSync(doomed);
    return false;
  }
  unlinkSync(doomed);
  return true;
}
