/**
 * The lease directory's one rule: a real directory (not a symlink) that this user owns, at mode 0700. Every writer in
 * the lease directory goes through it. No load-time side effects.
 */
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { isPid } from "./ps.js";
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
const REFUSED_ERRNOS = new Set([osConstants.errno.ELOOP, osConstants.errno.ENXIO, osConstants.errno.EOPNOTSUPP]);
/**
 * Opens `path` with `flags` plus `O_NOFOLLOW | O_NONBLOCK` (a planted symlink is not followed and a planted FIFO is not
 * waited on; a UNIX socket cannot be opened and is refused too) and returns the descriptor and its stats only for a regular file this user owns; a symlink or any other kind
 * of entry reads as `undefined` (a descriptor it opened is closed). Any other failed open throws. The one open rule of
 * every lease-directory read and append; the caller closes the descriptor.
 */
export function openOwnFile(path, flags, mode) {
    let fd;
    try {
        fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
    }
    catch (err) {
        // O_NOFOLLOW on a symlink: ELOOP (macOS, Linux), EMLINK (FreeBSD). Opening a UNIX socket: ENXIO (Linux), EOPNOTSUPP
        // (macOS, which Node may report as "Unknown system error -102", so the errno number is matched too).
        const { code, errno } = err;
        if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EOPNOTSUPP")
            return undefined;
        if (errno !== undefined && REFUSED_ERRNOS.has(Math.abs(errno)))
            return undefined;
        throw err;
    }
    let st;
    try {
        const s = fstatSync(fd);
        if (s.isFile() && !(process.getuid && s.uid !== process.getuid()))
            st = s;
    }
    finally {
        if (!st)
            closeSync(fd);
    }
    return st ? { fd, st } : undefined;
}
/** Appends `line` and a newline to `path` through `openOwnFile` (a new file has mode 0600); false when the target is refused. I/O errors propagate, so each caller keeps its own swallow. */
export function appendOwnLine(path, line) {
    const own = openOwnFile(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    if (!own)
        return false;
    try {
        appendFileSync(own.fd, `${line}\n`);
    }
    finally {
        closeSync(own.fd);
    }
    return true;
}
/**
 * The text and mtime of `path` through `openOwnFile`, or `undefined` when it is not a regular file this user owns (a
 * symlink, FIFO, directory, foreign file). Never blocks. A missing file or any other I/O error throws, for a caller that
 * tells them apart (the lease's holder and ticket scans).
 */
export function readOwnFile(path) {
    const own = openOwnFile(path, constants.O_RDONLY);
    if (!own)
        return undefined;
    try {
        return { text: readFileSync(own.fd, "utf-8"), mtimeMs: own.st.mtimeMs };
    }
    finally {
        closeSync(own.fd);
    }
}
/** The text and mtime of the record `<dir>/<name>`, or `undefined` when it is missing, unreadable, or not a regular file this user owns (a symlink, FIFO, directory, foreign file). Never blocks; the caller keeps its own body validation. */
export function readLeaseRecord(dir, name) {
    try {
        return readOwnFile(join(dir, name));
    }
    catch {
        return undefined;
    }
}
/** The text of a file the user named, which may be a symlink on purpose (dotfiles). It is opened non-blocking and read only when it is a regular file; a missing, unreadable or non-regular one throws, and a FIFO is never waited on. */
export function readRegularFile(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!fstatSync(fd).isFile())
            throw new Error(`${path} is not a regular file`);
        return readFileSync(fd, "utf-8");
    }
    finally {
        closeSync(fd);
    }
}
/**
 * The records of `<dir>/<sub>`, read-only: each canonical `<pid>.json` file (no leading zero; a `writeFileAtomic` temp
 * name is not one) with its text and mtime. A missing, symlinked or foreign subdirectory reads as empty, and an entry
 * that cannot be read, or is not a regular file this user owns (a symlink, FIFO, socket, directory), is skipped.
 * Creates and removes nothing.
 */
export function readRecordDir(dir, sub) {
    const path = join(dir, sub);
    try {
        if (!isOwnDir(lstatSync(path)))
            return [];
        return readdirSync(path).flatMap((name) => {
            const stem = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
            const rec = isPid(stem) ? readLeaseRecord(path, name) : undefined;
            return rec ? [{ stem, ...rec }] : [];
        });
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=lease-dir.js.map