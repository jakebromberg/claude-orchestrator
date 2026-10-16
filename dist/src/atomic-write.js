import { randomBytes } from "node:crypto";
import { renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
/**
 * Writes `text` to `file` through a temp file in the same directory and a rename, so a reader sees the old content or the new, never a torn write.
 * The temp name is unique per process and call, so writers that hold no lock never share one. The temp file is removed when the write or rename fails; the error propagates.
 */
export function writeFileAtomic(file, text, { mode = 0o600, mtimeMs } = {}) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, text, { mode });
        if (mtimeMs !== undefined)
            utimesSync(tmp, mtimeMs / 1000, mtimeMs / 1000);
        renameSync(tmp, file);
    }
    catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}
//# sourceMappingURL=atomic-write.js.map