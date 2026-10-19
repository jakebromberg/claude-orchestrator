import { type LeaseEvent } from "./lease.js";
/** Size past which a sink rotates its file to `<file>.1`; one generation of each is kept. */
export declare const ROTATE_BYTES: number;
type SinkDeps = {
    now?: () => number;
    maxBytes?: number;
    warn?: (msg: string) => void;
    rename?: (from: string, to: string) => void;
};
/**
 * Appends `{ ts, ...event }` lines to `<dir>/<name>` and rotates it to `<name>.1`; `leaseEventSink` is this sink on
 * `events.jsonl`, and `pressure.jsonl` is another. Appends only to a lease directory the lease itself accepts (a real
 * directory this user owns, which the lease creates at its first acquire), so a read-only mode creates nothing and a
 * directory the lease refused gets no write. Only a regular file is appended to, and a new one has mode 0600. Past
 * `maxBytes` (default 5 MB) the file is renamed to a single `<name>.1`, replacing any previous one; when that rename fails, the event is still
 * appended and `warn` (default: stderr) is called once per sink. A rename that finds the file gone (another process
 * rotated first) is the expected race and is not reported. A write failure is swallowed: the log is a diagnostic
 * and must never fail an acquire or a release. Two processes rotating at once can drop one generation of lines.
 */
export declare function jsonlSink<T extends object>(dir: string, name: string, deps?: SinkDeps): (e: T) => void;
/** The lease's `onEvent` sink: `events.jsonl` under `dir`. */
export declare const leaseEventSink: (dir: string, deps?: SinkDeps) => ((e: LeaseEvent) => void);
export {};
