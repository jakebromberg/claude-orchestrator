/** The step at `normal` (and `unknown`): today's ceiling. */
const MAX_STEP = 4;
/** Today's capacities: `normal` 4, `warning` 1, `critical` 0, and a rise at once. */
export const DEFAULT_STEP_TABLE = { warning: [{ minFreePct: 0, step: 1 }], riseHoldMs: 0 };
function targetStep({ level, freePct = 0 }, table) {
    if (level === "critical")
        return 0;
    if (level === "warning")
        return Math.max(0, ...table.warning.filter((band) => freePct >= band.minFreePct).map((band) => band.step));
    return MAX_STEP;
}
/**
 * The step for `signals` after `previous` (absent: start at the target). A lower
 * target applies at once and `critical` is always 0. A higher one applies one
 * step per call, each after `table.riseHoldMs` with a higher target holding
 * (`previous.risingSince`; one dated after `nowMs` restarts the hold). With a
 * zero hold a rise reaches its target at once.
 */
export function headroomStep(signals, previous, nowMs, table) {
    const target = targetStep(signals, table);
    const current = previous?.step ?? target;
    if (target <= current)
        return { step: target, risingSince: null };
    const since = previous?.risingSince != null && previous.risingSince <= nowMs ? previous.risingSince : nowMs;
    if (nowMs - since < table.riseHoldMs)
        return { step: current, risingSince: since };
    const step = table.riseHoldMs > 0 ? current + 1 : target;
    return { step, risingSince: step < target ? nowMs : null };
}
//# sourceMappingURL=headroom.js.map