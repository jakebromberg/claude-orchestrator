/**
 * The text of the lease's two user-facing lines, shared by the CLI and hook mode so they cannot drift apart. ship-dag's
 * give-up rule matches the `lease: no slot after` prefix. Does no work at load, so the library barrel can import it.
 */
import type { LeaseHandle, LeaseRefusal, LeaseStatus } from "./lease.js";

export const seconds = (ms: number): number => Math.round(ms / 1000);

/** The admitted line; the hook prints the same text as `additionalContext`. */
export function formatAdmitted(a: LeaseHandle["admission"]): string {
  return `lease: admitted after ${seconds(a.waitedMs)}s (pressure=${a.level}, ${a.live}/${a.capacity} live)`;
}

/** The no-slot line; the hook denies with it as the reason. */
export function formatNoSlot(refusal: LeaseRefusal, status: LeaseStatus): string {
  const holders = status.live.map((h) => `${h.pid} ${h.command}`).join(", ") || "none";
  return `lease: no slot after ${seconds(refusal.waitedMs)}s (pressure=${refusal.level}, capacity ${status.capacity}, ${status.live.length} live: ${holders}); rerun the command — this is not a test failure`;
}
