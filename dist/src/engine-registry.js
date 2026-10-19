import { rmSync } from "node:fs";
import { join } from "node:path";
import { sweepDeadTemps, writeFileAtomic } from "./atomic-write.js";
import { ensureOwnSubdir } from "./lease-dir.js";
import { pidAlive } from "./lease.js";
import { psField } from "./ps.js";
/** How often a live engine rewrites its record; the watchdog derives its freshness window from it. */
export const REFRESH_MS = 30_000;
/** The bounded `ps` reader (see `ps.ts`): a hung `ps` must not slow engine start. */
const psPgid = (pid) => Number(psField(pid, "pgid"));
/**
 * File-backed registry: writes `engines/<pid>.json` at `start`, rewrites it every 30 s on an unref'd timer
 * (its mtime tells a reader a live engine from a dead one) and removes it at `stop`. `start` first removes the temp files that dead writers left in `engines/`. `engines/` follows the lease's directory rule (`ensureOwnSubdir`); I/O errors, a refused directory included, are swallowed.
 */
export function createFileEngineRegistry(options) {
    const pid = options.pid ?? process.pid;
    const file = join(options.dir, "engines", `${pid}.json`);
    let timer;
    const write = (record) => {
        try {
            ensureOwnSubdir(options.dir, "engines");
            writeFileAtomic(file, JSON.stringify(record));
        }
        catch { }
    };
    return {
        start(info) {
            let pgid = null;
            try {
                const read = (options.pgid ?? psPgid)(pid);
                if (Number.isInteger(read))
                    pgid = read;
            }
            catch { }
            try {
                ensureOwnSubdir(options.dir, "engines");
                sweepDeadTemps(join(options.dir, "engines"), options.isAlive ?? pidAlive);
            }
            catch { }
            const record = { pid, pgid, ...info, startedAt: (options.now?.() ?? new Date()).toISOString() };
            write(record);
            timer = setInterval(() => write(record), REFRESH_MS);
            timer.unref();
        },
        stop() {
            clearInterval(timer);
            timer = undefined;
            try {
                rmSync(file, { force: true });
            }
            catch { }
        },
    };
}
//# sourceMappingURL=engine-registry.js.map