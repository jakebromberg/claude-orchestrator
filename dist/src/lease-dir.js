/**
 * The lease directory's one rule: a real directory (not a symlink) that this user owns, at mode 0700. Every writer in
 * the lease directory goes through it. No load-time side effects.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
/**
 * The lease's directory rule, applied to the lease directory and its subdirectory `name`: each is created with mode
 * 0700, one this user owns is tightened to 0700, and one that is a symlink, not a directory, or another user's throws
 * (an I/O error). A platform without uids (Windows) skips the ownership check.
 */
export function ensureOwnSubdir(dir, name) {
    for (const d of [dir, join(dir, name)]) {
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const st = lstatSync(d);
        if (!isOwnDir(st))
            throw new Error(`lease: ${d} is not a directory this user owns`);
        if (st.mode & 0o077)
            chmodSync(d, 0o700);
    }
}
/** The lease's directory rule, given `lstat` stats: a real directory (not a symlink) this user owns. A platform without uids (Windows) skips the ownership check. */
export function isOwnDir(st) {
    return st.isDirectory() && !(process.getuid && st.uid !== process.getuid());
}
/**
 * Writes `<dir>/<name>` through `writeFileAtomic` only when `dir` passes `isOwnDir`; returns whether it wrote. It never
 * creates `dir`, so a read-only caller creates nothing, and a missing, symlinked or foreign `dir` gets no write. An I/O
 * error from the write propagates.
 */
export function writeLeaseRecord(dir, name, text, opts) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st || !isOwnDir(st))
        return false;
    writeFileAtomic(join(dir, name), text, opts);
    return true;
}
//# sourceMappingURL=lease-dir.js.map