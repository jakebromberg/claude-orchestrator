import type { PressureLevel, PressureSampler } from "./memory-pressure.js";
import type { Logger } from "./types.js";
/** A change of the shown level, as written to `pressure.jsonl`. */
export interface CapacityTransition {
    type: "capacity-transition";
    /** The engine run id, when the governor was given one. */
    runId?: string;
    from: PressureLevel;
    to: PressureLevel;
    /** Launch capacity after the change. */
    capacity: number;
}
export interface CapacityGovernor {
    /** Launch capacity as of the last `tick`: how many pipelines the pool admits into a slot (see {@link sessionCapacity}). A pipeline already holding a slot keeps it when this drops. */
    capacity(): number;
    /** Re-read the sampler and update `capacity()`. */
    tick(): void;
}
/**
 * Turns pressure readings into a launch capacity: K (`maxParallel`) at every
 * level but `critical`, where it is 0. With `adaptive`, the shown level stays
 * at `warning` or `critical` until `normal` has held for 60 s (a debounce, not
 * a prediction), but `warning` no longer lowers capacity, so a `critical`
 * followed by a `warning` reading reopens capacity to K on that first reading;
 * only `critical` followed straight by `normal` waits out the 60 s. Without
 * `adaptive`, `warning` is ignored and there is no hysteresis, but `critical`
 * still closes capacity.
 * The first reading is taken at creation; each transition is logged once and passed to `onTransition`
 * (a callback that throws is ignored), tagged with `runId` when given.
 */
export declare function createCapacityGovernor(opts: {
    sampler: PressureSampler;
    maxParallel: number;
    adaptive: boolean;
    logger: Logger;
    runId?: string;
    onTransition?: (e: CapacityTransition) => void;
    /** Monotonic milliseconds, used to time the 60 s hysteresis. Defaults to `performance.now()`; do not inject `Date.now`, since a backward wall-clock step would stretch the hold. */
    now?: () => number;
}): CapacityGovernor;
