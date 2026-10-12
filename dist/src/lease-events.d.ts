import { type LeaseEvent } from "./lease.js";
/**
 * Appends only to a lease directory the lease itself accepts (a real directory this user owns, which the lease creates
 * at its first acquire), so a read-only mode creates nothing and a directory the lease refused gets no write. Only a
 * regular `events.jsonl` is appended to, and a new one has mode 0600. Past `maxBytes` (default 5 MB) the file is
 * renamed to a single `events.jsonl.1`, replacing any previous one; when that rename fails, the event is still
 * appended and `warn` (default: stderr) is called once per sink. A rename that finds the file gone (another process
 * rotated first) is the expected race and is not reported. A write failure is swallowed: the log is a diagnostic
 * and must never fail an acquire or a release. Two processes rotating at once can drop one generation of lines.
 */
export declare function leaseEventSink(dir: string, deps?: {
    now?: () => number;
    maxBytes?: number;
    warn?: (msg: string) => void;
    rename?: (from: string, to: string) => void;
}): (e: LeaseEvent) => void;
