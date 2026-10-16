/** The step at `normal` (and `unknown`): today's ceiling. */
export const MAX_STEP = 4;
/** Today's capacities: `normal` 4, `warning` 1, `critical` 0, and a rise at once. */
export const DEFAULT_STEP_TABLE = { warning: [{ minFreePct: 0, step: 1 }], riseHoldMs: 0 };
/** Heavy-command slots at `step`: step 4 gets the whole ceiling, a lower step at most that many, step 0 none. */
export function headroomCapacity(step, policy) {
    return step >= MAX_STEP ? policy.heavyCeiling : Math.min(policy.heavyCeiling, step);
}
/** A band's step is clamped to 0..`MAX_STEP`, so a mistyped table cannot exceed the ceiling or go negative. */
function targetStep({ level, freePct = 0 }, table) {
    if (level === "critical")
        return 0;
    if (level === "warning")
        return Math.max(0, ...table.warning.filter((band) => freePct >= band.minFreePct).map((band) => Math.min(MAX_STEP, Math.max(0, band.step))));
    return MAX_STEP;
}
/**
 * The step for `signals` after `previous` (absent: start at the target). A lower
 * target applies at once and `critical` is always 0. A higher one applies one
 * step per call, each after `table.riseHoldMs` with a higher target holding
 * (`previous.risingSince`; one dated after `nowMs`, or not finite, restarts the
 * hold). With a zero hold a rise reaches its target at once. A `previous.step`
 * that is not an integer from 0 to `MAX_STEP` is treated as absent, as `previous` may come from disk.
 */
export function headroomStep(signals, previous, nowMs, table) {
    const target = targetStep(signals, table);
    const trusted = previous && Number.isInteger(previous.step) && previous.step >= 0 && previous.step <= MAX_STEP ? previous : undefined;
    const current = trusted?.step ?? target;
    if (target <= current)
        return { step: target, risingSince: null };
    const since = trusted && Number.isFinite(trusted.risingSince) && trusted.risingSince <= nowMs ? trusted.risingSince : nowMs;
    if (nowMs - since < table.riseHoldMs)
        return { step: current, risingSince: since };
    const step = table.riseHoldMs > 0 ? current + 1 : target;
    return { step, risingSince: step < target ? nowMs : null };
}
//# sourceMappingURL=headroom.js.map