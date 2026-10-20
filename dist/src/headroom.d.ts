/**
 * The headroom step: a 0-to-4 admission step computed from the kernel's memory
 * signals and a data table, so retuning the bands is a one-line change. Pure;
 * `headroom-sampler.ts` shares its result machine-wide.
 */
import type { MemorySignals } from "./memory-pressure.js";
/** The step at `normal` (and `unknown`): today's ceiling. */
export declare const MAX_STEP = 4;
/** `step` applies while free memory is at least `minFreePct`; the best band met wins, so order does not matter. */
export interface StepBand {
    minFreePct: number;
    step: number;
}
export interface StepTable {
    /** Steps at `warning` by free percentage; a reading that meets no band is step 0. */
    warning: StepBand[];
    /** How long a higher target must hold before the step rises by one; 0 rises to the target at once. */
    riseHoldMs: number;
}
/** The step and, while a higher target is holding, the wall-clock ms it began to hold (`null` otherwise). Also the `previous` of the next call. */
export interface HeadroomState {
    step: number;
    risingSince: number | null;
}
/**
 * How long a heavy holder takes to grow into the memory it will use. Until a holder is this old, admission charges its full weight and
 * the free reading is not trusted to include it. A conservative placeholder, not a measured ramp: `pressure.jsonl` from 2026-10-19 (13:37 PDT
 * onward) is too thin to give a value (samples 10 to 60 s apart, free memory moving 10 points in 10 s with other use, holders living seconds
 * to minutes, all of them short hook holders, so no reading shows a heavy holder growing). It is also `riseHoldMs`. Revisit when a long-lived holder can be followed through its growth.
 */
export declare const RAMP_MS = 300000;
/** The owner's Q1 table: `normal` 4, `warning` 3 at 40% free or more, 2 at 30 to 39%, 1 under 30%, `critical` 0, and a rise of one step per ramp window (a rise must not outrun holders that have not grown yet; the session row shares it). */
export declare const DEFAULT_STEP_TABLE: StepTable;
/** Heavy-command slots at `step`: step 4 gets the whole `ceiling`, a lower step at most that many, step 0 none. */
export declare function headroomCapacity(step: number, ceiling: number): number;
/** What the free-memory budget reads: bytes free now, the reserve, and the weight of the holders old enough that the free reading already includes them. */
export interface FreeBudget {
    freeBytes: number;
    reserve: number;
    settled: number;
}
/**
 * The bytes the heavy class may hold at `step`. With a free reading: free memory less the reserve, plus the weight of the settled holders
 * (their use is already out of the free bytes), at most `usable` and none at step 0. Without one: `step / 4` of `usable`, none at step 0.
 */
export declare function heavyBudget(step: number, usable: number, free?: FreeBudget): number;
/** Implementer-session slots at `step`: step 4 gets the whole `ceiling`, steps 3, 2 and 1 get 4, 2 and 1 (each capped by it), step 0 none. */
export declare function sessionHeadroomCapacity(step: number, ceiling: number): number;
/**
 * The step for `signals` after `previous` (absent: start at the target). A lower
 * target applies at once and `critical` is always 0. A higher one applies one
 * step per call, each after `table.riseHoldMs` with a higher target holding
 * (`previous.risingSince`; one dated after `nowMs`, or not finite, restarts the
 * hold). With a zero hold a rise reaches its target at once. A `previous.step`
 * that is not an integer from 0 to `MAX_STEP` is treated as absent, as `previous` may come from disk.
 */
export declare function headroomStep(signals: MemorySignals, previous: HeadroomState | undefined, nowMs: number, table: StepTable): HeadroomState;
