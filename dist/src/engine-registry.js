import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REFRESH_MS = 30_000;
/** Bounded like the lease's own `ps` calls (2 s, stderr ignored): a hung `ps` must not slow engine start. */
const psPgid = (pid) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim());
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
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
            renameSync(tmp, file);
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