/**
 * A non-blocking, mtime-aged mutex for the heavy-command lease. It makes one
 * attempt and returns; it never spins, sleeps, or throws on contention, so a
 * busy mutex reads as "not admitted this poll". (The counter store keeps its
 * own PID-reaping, spinning lock.)
 *
 * A lock is fresh while its mtime is within `staleAfterMs` of `now()`, before or
 * after, and stale outside that. The pressure sampler's `isFresh` instead counts
 * any future reading as not fresh. There, "not fresh" only means "read again";
 * here it means "delete another process's lock", so a small backward step of the
 * clock must not reap a live holder. A lock dated more than `staleAfterMs` ahead
 * is still reaped, so a bogus far-future mtime cannot hold the mutex forever.
 *
 * Mutual exclusion holds while every holder releases within `staleAfterMs` and
 * the clock does not step by more than that either way. A holder that overruns
 * counts as dead, and its lock may be reaped and taken while it still runs. Its
 * late `release()` leaves the new holder's lock alone, and a reaper removes only
 * the file it judged stale, except in two remaining races:
 * - the lock is reaped and re-created between a late release's token check and
 *   its unlink;
 * - the lock is removed and re-created between a reaper's last `lstat` (which
 *   checks that the lock is still the file it judged stale) and its unlink. The
 *   remover is a late release, or another reaper that took this reaper's turn
 *   because this one stalled there past `staleAfterMs`.
 */
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
/**
 * One `O_EXCL` create; on `EEXIST`, reaps a stale lock and retries once. Returns
 * `null` while another holder has it. Throws on any other I/O error.
 */
export function tryLockOnce(lockFile, { staleAfterMs, now = Date.now }) {
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
    const lock = {
        release() {
            try {
                if (readFileSync(lockFile, "utf8") === token)
                    rmSync(lockFile);
            }
            catch {
                // Already reaped as stale; nothing to release.
            }
        },
    };
    if (create(lockFile, token))
        return lock;
    if (!reapIfStale(lockFile, staleAfterMs, now))
        return null;
    return create(lockFile, token) ? lock : null;
}
function create(lockFile, token) {
    let fd;
    try {
        fd = openSync(lockFile, "wx", 0o600);
    }
    catch (err) {
        if (err.code === "EEXIST")
            return false;
        throw err;
    }
    try {
        writeSync(fd, token);
    }
    catch (err) {
        // Leave no empty lock that nobody holds: it would read as busy until stale.
        closeSync(fd);
        rmSync(lockFile, { force: true });
        throw err;
    }
    closeSync(fd);
    return true;
}
/**
 * The lock file's own `lstat` (a symlink is not followed) when it is stale,
 * `false` while it is fresh, and `undefined` when it is gone (`ENOENT`); any
 * other error throws. The mtime is floored to the clock's whole milliseconds.
 */
function staleStats(lockFile, staleAfterMs, now) {
    const stats = lstatSync(lockFile, { throwIfNoEntry: false });
    if (!stats)
        return undefined;
    return Math.abs(now() - Math.floor(stats.mtimeMs)) <= staleAfterMs ? false : stats;
}
/** True when the lock is gone (reaped by us, or released) and a create is worth retrying. */
function reapIfStale(lockFile, staleAfterMs, now) {
    if (staleStats(lockFile, staleAfterMs, now) === false)
        return false;
    // Reapers take turns through a lock of their own (this same mutex, one level
    // down, so a reaper that dies mid-reap is reaped in turn). No reaper can then
    // remove a lock that another reaper has just reaped and re-created.
    const turn = tryLockOnce(`${lockFile}.reap`, { staleAfterMs, now });
    if (!turn)
        return false;
    try {
        const stale = staleStats(lockFile, staleAfterMs, now);
        if (!stale)
            return stale === undefined;
        // A reaper that stalled past `staleAfterMs` since that check has lost its
        // turn, and the lock may now be another holder's: remove only the same file.
        const current = lstatSync(lockFile, { throwIfNoEntry: false });
        if (!current)
            return true;
        if (current.dev !== stale.dev || current.ino !== stale.ino || current.mtimeMs !== stale.mtimeMs)
            return false;
        rmSync(lockFile, { force: true });
        return true;
    }
    finally {
        turn.release();
    }
}
//# sourceMappingURL=file-lock.js.map