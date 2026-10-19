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

/** The disk-full line; the hook denies with it and the CLI prints it. Unlike `formatNoSlot` it says not to rerun. */
export function formatDiskFull(refusal: LeaseRefusal): string {
  return `lease: the disk is full (${refusal.code ?? "ENOSPC"}); free space before running heavy commands — do not rerun`;
}

/** The one text of any refusal: the disk-full line for `disk-full`, else the no-slot line. */
export const formatRefusal = (refusal: LeaseRefusal, status: LeaseStatus): string =>
  refusal.refused === "disk-full" ? formatDiskFull(refusal) : formatNoSlot(refusal, status);

/** Why a refusal stops work: `disk-full` for a full disk, else `memory-critical`. */
export const refusalStopReason = (refusal: LeaseRefusal): "memory-critical" | "disk-full" => (refusal.refused === "disk-full" ? "disk-full" : "memory-critical");

/** The CLI's exit code for a refusal: 74 for a full disk, else 75 (no slot). */
export const refusalExitCode = (refusal: LeaseRefusal): number => (refusal.refused === "disk-full" ? 74 : 75);
