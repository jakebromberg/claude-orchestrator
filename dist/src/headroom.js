/** The step at `normal` (and `unknown`): today's ceiling. */
export const MAX_STEP = 4;
/**
 * How long a heavy holder takes to grow into the memory it will use. Until a holder is this old, admission charges its full weight and
 * the free reading is not trusted to include it. Chosen from `pressure.jsonl` on 2026-10-19: after four holders were admitted at once,
 * free memory kept falling for 70 s to 4.5 min (43% to 31% free at 17:01 to 17:05 PT).
 */
export const RAMP_MS = 300_000;
/** The owner's Q1 table: `normal` 4, `warning` 3 at 40% free or more, 2 at 30 to 39%, 1 under 30%, `critical` 0, and a rise of one step per ramp window (a rise must not outrun holders that have not grown yet; the session row shares it). */
export const DEFAULT_STEP_TABLE = {
    warning: [
        { minFreePct: 40, step: 3 },
        { minFreePct: 30, step: 2 },
        { minFreePct: 0, step: 1 },
    ],
    riseHoldMs: RAMP_MS,
};
/** Heavy-command slots at `step`: step 4 gets the whole `ceiling`, a lower step at most that many, step 0 none. */
export function headroomCapacity(step, ceiling) {
    return step >= MAX_STEP ? ceiling : Math.min(ceiling, step);
}
/**
 * The bytes the heavy class may hold at `step`. With a free reading: free memory less the reserve, plus the weight of the settled holders
 * (their use is already out of the free bytes), at most `usable` and none at step 0. Without one: `step / 4` of `usable`, none at step 0.
 */
export function heavyBudget(step, usable, free) {
    if (!free)
        return (usable * Math.min(MAX_STEP, Math.max(0, step))) / MAX_STEP;
    return step > 0 ? Math.min(usable, Math.max(0, free.freeBytes - free.reserve + free.settled)) : 0;
}
/** The session row below step 4, by step. */
const SESSION_ROW = [0, 1, 2, 4];
/** Implementer-session slots at `step`: step 4 gets the whole `ceiling`, steps 3, 2 and 1 get 4, 2 and 1 (each capped by it), step 0 none. */
export function sessionHeadroomCapacity(step, ceiling) {
    return step >= MAX_STEP ? ceiling : Math.min(ceiling, SESSION_ROW[step] ?? 0);
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