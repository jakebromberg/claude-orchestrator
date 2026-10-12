import type { PressureSampler } from "./memory-pressure.js";
import type { Logger } from "./types.js";
export interface CapacityGovernor {
    /** Concurrent sessions allowed as of the last `tick`. */
    capacity(): number;
    /** Re-read the sampler and update `capacity()`. */
    tick(): void;
}
/**
 * Turns pressure readings into a session capacity. With `adaptive`, capacity
 * stays at the lower value after `warning` or `critical` until `normal` has
 * held for 60 s (a debounce, not a prediction). Without it, `warning` is
 * ignored and there is no hysteresis, but `critical` still closes capacity.
 * The first reading is taken at creation; each transition is logged once.
 */
export declare function createCapacityGovernor(opts: {
    sampler: PressureSampler;
    maxParallel: number;
    adaptive: boolean;
    logger: Logger;
    now?: () => number;
}): CapacityGovernor;
