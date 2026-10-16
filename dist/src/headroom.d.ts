/**
 * The headroom step: a 0-to-4 admission step computed from the kernel's memory
 * signals and a data table, so retuning the bands is a one-line change. Pure;
 * `headroom-sampler.ts` shares its result machine-wide.
 */
import type { MemorySignals, PressurePolicy } from "./memory-pressure.js";
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
/** The owner's Q1 table: `normal` 4, `warning` 3 at 40% free or more, 2 at 30 to 39%, 1 under 30%, `critical` 0, and a rise of one step per 60 s. */
export declare const DEFAULT_STEP_TABLE: StepTable;
/** Heavy-command slots at `step`: step 4 gets the whole ceiling, a lower step at most that many, step 0 none. */
export declare function headroomCapacity(step: number, policy: PressurePolicy): number;
/**
 * The step for `signals` after `previous` (absent: start at the target). A lower
 * target applies at once and `critical` is always 0. A higher one applies one
 * step per call, each after `table.riseHoldMs` with a higher target holding
 * (`previous.risingSince`; one dated after `nowMs`, or not finite, restarts the
 * hold). With a zero hold a rise reaches its target at once. A `previous.step`
 * that is not an integer from 0 to `MAX_STEP` is treated as absent, as `previous` may come from disk.
 */
export declare function headroomStep(signals: MemorySignals, previous: HeadroomState | undefined, nowMs: number, table: StepTable): HeadroomState;
