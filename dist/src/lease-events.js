/**
 * JSONL sink for the lease's `onEvent` seam: one `{ ts, ...event }` line per event appended to
 * `<lease dir>/events.jsonl`. Events pass through unchanged, so a new event type or reap reason needs no change here.
 */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { defaultWarn, isOwnDir } from "./lease.js";
const MAX_BYTES = 5 * 1024 * 1024;
// A planted symlink is not followed and a planted FIFO is not waited on.
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/**
 * Appends only to a lease directory the lease itself accepts (a real directory this user owns, which the lease creates
 * at its first acquire), so a read-only mode creates nothing and a directory the lease refused gets no write. Only a
 * regular `events.jsonl` is appended to, and a new one has mode 0600. Past `maxBytes` (default 5 MB) the file is
 * renamed to a single `events.jsonl.1`, replacing any previous one; when that rename fails, the event is still
 * appended and `warn` (default: stderr) is called once per sink. A rename that finds the file gone (another process
 * rotated first) is the expected race and is not reported. A write failure is swallowed: the log is a diagnostic
 * and must never fail an acquire or a release. Two processes rotating at once can drop one generation of lines.
 */
export function leaseEventSink(dir, deps = {}) {
    const { now = Date.now, maxBytes = MAX_BYTES, warn = defaultWarn, rename = renameSync } = deps;
    const file = join(dir, "events.jsonl");
    let warned = false;
    return (e) => {
        try {
            if (!isOwnDir(lstatSync(dir)))
                return;
            if ((lstatSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) {
                try {
                    rename(file, `${file}.1`);
                }
                catch (err) {
                    // ENOENT: another process rotated first, which is the expected race, not a failure.
                    if (!warned && err.code !== "ENOENT") {
                        warned = true;
                        warn(`lease: cannot rotate ${file}; appending past ${maxBytes} bytes: ${String(err)}`);
                    }
                }
            }
            const fd = openSync(file, OPEN_FLAGS, 0o600);
            try {
                if (fstatSync(fd).isFile())
                    appendFileSync(fd, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...e })}\n`);
            }
            finally {
                closeSync(fd);
            }
        }
        catch {
            // Nothing to report to: the lease's own `warn` is for lease problems.
        }
    };
}
//# sourceMappingURL=lease-events.js.map