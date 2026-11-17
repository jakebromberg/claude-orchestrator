export const seconds = (ms) => Math.round(ms / 1000);
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
/** `, weights <used>/<budget> GB` in weight mode, else nothing. */
const weightsText = (w) => (w ? `, weights ${gb(w.used)}/${gb(w.budget)} GB` : "");
/** The least time between two progress lines of one wait for a lease slot (the post-check's and the engine's session wait). */
export const WAIT_LOG_INTERVAL_MS = 60_000;
/**
 * A wait's `onWait` that calls `write` on the first poll and then at most once per {@link WAIT_LOG_INTERVAL_MS} of
 * `waitedMs`; with `skipFirst` the first line waits for the first interval instead (the CLI's rule). A throwing `write` is swallowed, so a progress line never changes what the wait does.
 */
export function throttledProgress(write, { skipFirst = false } = {}) {
    let last = skipFirst ? 0 : undefined;
    return (s) => {
        if (last !== undefined && s.waitedMs - last < WAIT_LOG_INTERVAL_MS)
            return;
        last = s.waitedMs;
        try {
            write(s);
        }
        catch { }
    };
}
/** The admitted line; the hook prints the same text as `additionalContext`. */
export function formatAdmitted(a) {
    return `lease: admitted after ${seconds(a.waitedMs)}s (pressure=${a.level}, ${a.live}/${a.capacity} live${weightsText(a.weights)})`;
}
/** The no-slot line; the hook denies with it as the reason. */
export function formatNoSlot(refusal, status) {
    const holders = status.live.map((h) => `${h.pid} ${h.command}`).join(", ") || "none";
    const unmanaged = refusal.pids?.length ? `; a UI-test run that holds no slot is in progress (pid ${refusal.pids.join(", ")})` : "";
    return `lease: no slot after ${seconds(refusal.waitedMs)}s (pressure=${refusal.level}, capacity ${status.capacity}${weightsText(status.weights)}, ${status.live.length} live: ${holders})${unmanaged}; rerun the command — this is not a test failure`;
}
/** The disk-full line; the hook denies with it and the CLI prints it. Unlike `formatNoSlot` it says not to rerun. */
export function formatDiskFull(refusal) {
    return `lease: the disk is full (${refusal.code ?? "ENOSPC"}); free space before running heavy commands — do not rerun`;
}
/** The lines of the refusals only the UI-test class gives, without the `lease: ` prefix (the post-check's summary reuses them). */
const uiTestReason = (refusal) => refusal.refused === "io-error"
    ? `the lease directory could not be used for ${seconds(refusal.waitedMs)}s (${refusal.code ?? "I/O error"}), so the UI-test slot was not taken; check the lease directory and rerun the command`
    : refusal.refused === "slot-lost"
        ? "the UI-test slot was lost while waiting for a heavy slot (it expired or was removed); rerun the command"
        : refusal.refused === "ui-test-running"
            ? refusal.pids?.length
                ? `the UI-test slot was not taken: a UI-test run is in progress (pid ${refusal.pids.join(", ")}) that holds no slot; wait for it to end and rerun the command`
                : `the UI-test slot was not taken: could not tell whether a UI-test run is in progress (the process table was unreadable for ${seconds(refusal.waitedMs)}s); rerun the command`
            : refusal.refused === "nested-ui-test"
                ? "this UI test runs inside another call's lease slot (a hook call's, or a parent's heavy slot with no UI-test slot behind it), and waiting for the UI-test slot while that is held could deadlock; run the UI test as its own Bash call so it takes both slots"
                : undefined;
/** The one text of any refusal: the disk-full line for `disk-full`, the UI-test class's own line for `io-error`, `slot-lost` and `nested-ui-test`, else the no-slot line. */
export const formatRefusal = (refusal, status) => refusal.refused === "disk-full" ? formatDiskFull(refusal) : (uiTestReason(refusal) ? `lease: ${uiTestReason(refusal)}` : formatNoSlot(refusal, status));
/** The post-check's summary for a refusal. Its memory-critical stop is terminal, so unlike `formatNoSlot` it has no `lease: no slot after` prefix and does not say to rerun. */
export const formatPostCheckStop = (refusal) => refusal.refused === "disk-full"
    ? `Post-session check not run: ${formatDiskFull(refusal)}`
    : uiTestReason(refusal)
        ? `post-check: skipped because the UI-test slot could not be taken (${uiTestReason(refusal)}); the check did not run, and the issue stopped as lease-wait`
        : `post-check: skipped because memory pressure is critical (${refusal.level}, ${refusal.live} live); the check did not run and will not be retried`;
/** Why a refusal stops work: `disk-full` for a full disk, `lease-wait` for a UI-test slot that could not be taken or held (a lease problem the owner reruns, not memory pressure), else `memory-critical`. */
export const refusalStopReason = (refusal) => refusal.refused === "disk-full" ? "disk-full" : uiTestReason(refusal) ? "lease-wait" : "memory-critical";
/** The CLI's exit code for a refusal: 74 for a full disk, else 75 (no slot). */
export const refusalExitCode = (refusal) => (refusal.refused === "disk-full" ? 74 : 75);
//# sourceMappingURL=lease-messages.js.map