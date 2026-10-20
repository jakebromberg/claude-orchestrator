/**
 * The text of the lease's two user-facing lines, shared by the CLI and hook mode so they cannot drift apart. ship-dag's
 * give-up rule matches the `lease: no slot after` prefix. Does no work at load, so the library barrel can import it.
 */
import type { LeaseHandle, LeaseRefusal, LeaseStatus, Weights } from "./lease.js";

export const seconds = (ms: number): number => Math.round(ms / 1000);

const gb = (bytes: number): string => (bytes / 2 ** 30).toFixed(1);
/** `, weights <used>/<budget> GB` in weight mode, else nothing. */
const weightsText = (w: Weights | undefined): string => (w ? `, weights ${gb(w.used)}/${gb(w.budget)} GB` : "");
/** The least time between two progress lines of one wait for a lease slot (the post-check's and the engine's session wait). */
export const WAIT_LOG_INTERVAL_MS = 60_000;

/**
 * A wait's `onWait` that calls `write` on the first poll and then at most once per {@link WAIT_LOG_INTERVAL_MS} of
 * `waitedMs`; with `skipFirst` the first line waits for the first interval instead (the CLI's rule). A throwing `write` is swallowed, so a progress line never changes what the wait does.
 */
export function throttledProgress<S extends { waitedMs: number }>(write: (s: S) => void, { skipFirst = false } = {}): (s: S) => void {
  let last: number | undefined = skipFirst ? 0 : undefined;
  return (s) => {
    if (last !== undefined && s.waitedMs - last < WAIT_LOG_INTERVAL_MS) return;
    last = s.waitedMs;
    try {
      write(s);
    } catch {}
  };
}

/** The admitted line; the hook prints the same text as `additionalContext`. */
export function formatAdmitted(a: LeaseHandle["admission"]): string {
  return `lease: admitted after ${seconds(a.waitedMs)}s (pressure=${a.level}, ${a.live}/${a.capacity} live${weightsText(a.weights)})`;
}

/** The no-slot line; the hook denies with it as the reason. */
export function formatNoSlot(refusal: LeaseRefusal, status: LeaseStatus): string {
  const holders = status.live.map((h) => `${h.pid} ${h.command}`).join(", ") || "none";
  return `lease: no slot after ${seconds(refusal.waitedMs)}s (pressure=${refusal.level}, capacity ${status.capacity}${weightsText(status.weights)}, ${status.live.length} live: ${holders}); rerun the command — this is not a test failure`;
}

/** The disk-full line; the hook denies with it and the CLI prints it. Unlike `formatNoSlot` it says not to rerun. */
export function formatDiskFull(refusal: LeaseRefusal): string {
  return `lease: the disk is full (${refusal.code ?? "ENOSPC"}); free space before running heavy commands — do not rerun`;
}

/** The one text of any refusal: the disk-full line for `disk-full`, else the no-slot line. */
export const formatRefusal = (refusal: LeaseRefusal, status: LeaseStatus): string =>
  refusal.refused === "disk-full" ? formatDiskFull(refusal) : formatNoSlot(refusal, status);

/** The post-check's summary for a refusal. Its memory-critical stop is terminal, so unlike `formatNoSlot` it has no `lease: no slot after` prefix and does not say to rerun. */
export const formatPostCheckStop = (refusal: LeaseRefusal): string =>
  refusal.refused === "disk-full"
    ? `Post-session check not run: ${formatDiskFull(refusal)}`
    : `post-check: skipped because memory pressure is critical (${refusal.level}, ${refusal.live} live); the check did not run and will not be retried`;

/** Why a refusal stops work: `disk-full` for a full disk, else `memory-critical`. */
export const refusalStopReason = (refusal: LeaseRefusal): "memory-critical" | "disk-full" => (refusal.refused === "disk-full" ? "disk-full" : "memory-critical");

/** The CLI's exit code for a refusal: 74 for a full disk, else 75 (no slot). */
export const refusalExitCode = (refusal: LeaseRefusal): number => (refusal.refused === "disk-full" ? 74 : 75);
