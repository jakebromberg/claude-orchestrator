import { randomBytes } from "node:crypto";
import { linkSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPid } from "./ps.js";
const TEMP_NAME = /^.+\.(\d+)\.[0-9a-f]+\.tmp$/;
/** The pid in a `writeFileAtomic` temp name (`<file>.<pid>.<hex>.tmp`), or undefined for any other name. The one definition of the format outside the writer. */
export function tempOwnerPid(name) {
    const pid = TEMP_NAME.exec(name)?.[1];
    return pid === undefined ? undefined : Number(pid);
}
/** Removes the `writeFileAtomic` temp files in `dir` whose writer is dead; a name with no pid, or a live writer, stays. A missing or unreadable `dir` is skipped. */
export function sweepDeadTemps(dir, isAlive) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        const pid = tempOwnerPid(name);
        if (pid !== undefined && isPid(pid) && !isAlive(pid))
            removeQuietly(join(dir, name));
    }
}
const removeQuietly = (file) => {
    try {
        rmSync(file, { force: true });
    }
    catch { }
};
/**
 * Writes `text` to `file` through a temp file in the same directory and a rename, so a reader sees the old content or the new, never a torn write.
 * The temp name is unique per process and call, so writers that hold no lock never share one. The temp file is removed, best effort, on every path, and a failed removal never replaces the write's own result; the error of a failed write propagates.
 * With `exclusive` the temp file is linked instead, which fails with `EEXIST` when `file` exists.
 */
export function writeFileAtomic(file, text, { mode = 0o600, mtimeMs, exclusive = false } = {}) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, text, { mode });
        if (mtimeMs !== undefined)
            utimesSync(tmp, mtimeMs / 1000, mtimeMs / 1000);
        (exclusive ? linkSync : renameSync)(tmp, file);
    }
    catch (err) {
        removeQuietly(tmp);
        throw err;
    }
    if (exclusive)
        removeQuietly(tmp);
}
//# sourceMappingURL=atomic-write.js.map