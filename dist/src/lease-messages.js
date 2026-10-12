export const seconds = (ms) => Math.round(ms / 1000);
/** The admitted line; the hook prints the same text as `additionalContext`. */
export function formatAdmitted(a) {
    return `lease: admitted after ${seconds(a.waitedMs)}s (pressure=${a.level}, ${a.live}/${a.capacity} live)`;
}
/** The no-slot line; the hook denies with it as the reason. */
export function formatNoSlot(refusal, status) {
    const holders = status.live.map((h) => `${h.pid} ${h.command}`).join(", ") || "none";
    return `lease: no slot after ${seconds(refusal.waitedMs)}s (pressure=${refusal.level}, capacity ${status.capacity}, ${status.live.length} live: ${holders}); rerun the command — this is not a test failure`;
}
//# sourceMappingURL=lease-messages.js.map