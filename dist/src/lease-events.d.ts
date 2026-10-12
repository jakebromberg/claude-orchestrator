import type { LeaseEvent } from "./lease.js";
/**
 * Appends only while `dir` exists (the lease creates it at its first acquire), so a read-only mode creates nothing.
 * Past `maxBytes` (default 5 MB) the file is renamed to a single `events.jsonl.1`, replacing any previous one. A write
 * failure is swallowed: the log is a diagnostic and must never fail an acquire or a release. Two processes rotating at
 * once can drop one generation of lines.
 */
export declare function leaseEventSink(dir: string, deps?: {
    now?: () => number;
    maxBytes?: number;
}): (e: LeaseEvent) => void;
