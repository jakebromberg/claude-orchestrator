import { type StepTable } from "./headroom.js";
import { type MemorySignals, type PressureLevel, type PressureSampler } from "./memory-pressure.js";
/** What a process reads: the level and step with its own override applied, and the signals (`null` after a failed guarded read). */
export interface HeadroomReading {
    level: PressureLevel;
    step: number;
    signals: MemorySignals | null;
}
/** A cached sampler of the shared step; `fresh()` bypasses `headroom.json` and the cache, and rewrites the file. */
export interface HeadroomSampler {
    (): HeadroomReading;
    fresh(): HeadroomReading;
    /** True when the last reading returned was changed by `CO_PRESSURE_OVERRIDE`; absent means never. */
    overridden?(): boolean;
}
/**
 * The one production sampler: shares the step through `headroom.json` while it is under 10 s old, else reads
 * `sysctl`, steps from the stored `step` and `risingSince` (a record as old as a full climb, `riseHoldMs` × `MAX_STEP`, is ignored, so the step starts at the target), and rewrites the file and `level.json`. A failed guarded read
 * steps from the last good reading under 60 s old (in-process, else `level.json`), and otherwise from `critical`; it is
 * not shared. `CO_PRESSURE_OVERRIDE=critical-as-warning` maps `critical` to `warning` and step 0 to 1 in this process
 * only. Throws when `leaseDirectory(env)` does. `deps` exists for tests.
 */
export declare function defaultHeadroomSampler(env?: NodeJS.ProcessEnv, deps?: {
    read?: () => MemorySignals | null;
    now?: () => number;
    log?: (msg: string) => void;
    table?: StepTable;
}): HeadroomSampler;
/** The level a `HeadroomSampler` reads, as a `PressureSampler`: one source of truth, so `level` and `level.fresh` cannot disagree with the step. */
export declare function levelView(headroom: HeadroomSampler): PressureSampler;
