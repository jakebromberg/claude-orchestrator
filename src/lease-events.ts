/**
 * JSONL sink for the lease's `onEvent` seam: one `{ ts, ...event }` line per event appended to
 * `<lease dir>/events.jsonl`. Events pass through unchanged, so a new event type or reap reason needs no change here.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LeaseEvent } from "./lease.js";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Appends only while `dir` exists (the lease creates it at its first acquire), so a read-only mode creates nothing.
 * Past `maxBytes` (default 5 MB) the file is renamed to a single `events.jsonl.1`, replacing any previous one. A write
 * failure is swallowed: the log is a diagnostic and must never fail an acquire or a release. Two processes rotating at
 * once can drop one generation of lines.
 */
export function leaseEventSink(
  dir: string,
  deps: { now?: () => number; maxBytes?: number } = {},
): (e: LeaseEvent) => void {
  const { now = Date.now, maxBytes = MAX_BYTES } = deps;
  const file = join(dir, "events.jsonl");
  return (e) => {
    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...e })}\n`, { mode: 0o600 });
    } catch {
      // Nothing to report to: the lease's own `warn` is for lease problems.
    }
  };
}
