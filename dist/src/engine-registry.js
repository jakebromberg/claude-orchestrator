import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REFRESH_MS = 30_000;
const psPgid = (pid) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8" }).trim());
/**
 * File-backed registry: writes `engines/<pid>.json` at `start`, rewrites it every 30 s on an unref'd timer
 * (its mtime tells a reader a live engine from a dead one) and removes it at `stop`. I/O errors are swallowed.
 */
export function createFileEngineRegistry(options) {
    const pid = options.pid ?? process.pid;
    const file = join(options.dir, "engines", `${pid}.json`);
    let timer;
    const write = (record) => {
        try {
            mkdirSync(join(options.dir, "engines"), { recursive: true });
            writeFileSync(file, JSON.stringify(record));
        }
        catch { }
    };
    return {
        start(info) {
            let pgid = null;
            try {
                pgid = (options.pgid ?? psPgid)(pid);
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