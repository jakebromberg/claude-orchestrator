/**
 * The headroom step: a 0-to-4 admission step computed from the kernel's memory
 * signals and a data table, so retuning the bands is a one-line change. Pure;
 * nothing calls it yet.
 */
import type { MemorySignals } from "./memory-pressure.js";
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
/** Today's capacities: `normal` 4, `warning` 1, `critical` 0, and a rise at once. */
export declare const DEFAULT_STEP_TABLE: StepTable;
/**
 * The step for `signals` after `previous` (absent: start at the target). A lower
 * target applies at once and `critical` is always 0. A higher one applies one
 * step per call, each after `table.riseHoldMs` with a higher target holding
 * (`previous.risingSince`; one dated after `nowMs` restarts the hold). With a
 * zero hold a rise reaches its target at once.
 */
export declare function headroomStep(signals: MemorySignals, previous: HeadroomState | undefined, nowMs: number, table: StepTable): HeadroomState;
