/**
 * JSONL sink for the lease's `onEvent` seam: one `{ ts, ...event }` line per event appended to
 * `<lease dir>/events.jsonl`. Events pass through unchanged, so a new event type or reap reason needs no change here.
 */
import { appendFileSync, closeSync, constants, lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isOwnDir, openOwnFile } from "./lease-dir.js";
import { defaultWarn, type LeaseEvent } from "./lease.js";

/** Size past which a sink rotates its file to `<file>.1`; one generation of each is kept. */
export const ROTATE_BYTES = 5 * 1024 * 1024;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;

type SinkDeps = { now?: () => number; maxBytes?: number; warn?: (msg: string) => void; rename?: (from: string, to: string) => void };

/**
 * Appends `{ ts, ...event }` lines to `<dir>/<name>` and rotates it to `<name>.1`; `leaseEventSink` is this sink on
 * `events.jsonl`, and `pressure.jsonl` is another. Appends only to a lease directory the lease itself accepts (a real
 * directory this user owns, which the lease creates at its first acquire), so a read-only mode creates nothing and a
 * directory the lease refused gets no write. Only a regular file this user owns is appended to, and a new one has mode 0600. Past
 * `maxBytes` (default 5 MB) the file is renamed to a single `<name>.1`, replacing any previous one; when that rename fails, the event is still
 * appended and `warn` (default: stderr) is called once per sink. A rename that finds the file gone (another process
 * rotated first) is the expected race and is not reported. A write failure is swallowed: the log is a diagnostic
 * and must never fail an acquire or a release. Two processes rotating at once can drop one generation of lines.
 */
export function jsonlSink<T extends object>(dir: string, name: string, deps: SinkDeps = {}): (e: T) => void {
  const { now = Date.now, maxBytes = ROTATE_BYTES, warn = defaultWarn, rename = renameSync } = deps;
  const file = join(dir, name);
  let warned = false;
  return (e) => {
    try {
      if (!isOwnDir(lstatSync(dir))) return;
      if ((lstatSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) {
        try {
          rename(file, `${file}.1`);
        } catch (err) {
          // ENOENT: another process rotated first, which is the expected race, not a failure.
          if (!warned && (err as NodeJS.ErrnoException).code !== "ENOENT") {
            warned = true;
            warn(`lease: cannot rotate ${file}; appending past ${maxBytes} bytes: ${String(err)}`);
          }
        }
      }
      const fd = openOwnFile(file, OPEN_FLAGS, 0o600)?.fd;
      if (fd === undefined) return;
      try {
        appendFileSync(fd, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...e })}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Nothing to report to: the lease's own `warn` is for lease problems.
    }
  };
}

/** The lease's `onEvent` sink: `events.jsonl` under `dir`. */
export const leaseEventSink = (dir: string, deps: SinkDeps = {}): ((e: LeaseEvent) => void) => jsonlSink<LeaseEvent>(dir, "events.jsonl", deps);
