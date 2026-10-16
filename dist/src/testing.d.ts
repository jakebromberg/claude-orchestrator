import type { HeadroomReading, HeadroomSampler } from "./headroom-sampler.js";
import type { PressureLevel, PressureSampler } from "./memory-pressure.js";
export { InMemoryStatusStore, InMemoryMetadataStore } from "./status.js";
export { createSilentLogger } from "./log.js";
/**
 * A scripted `PressureSampler` for tests. `levels` is one level, a list (one level per reading, then the last one
 * held), or a function read on every call. `fresh()` reads like the sampler unless `options.fresh` models a stale
 * cache; `overridden()` exists only when `options.overridden` is set.
 */
export declare function scriptedPressureSampler(levels: PressureLevel | readonly PressureLevel[] | (() => PressureLevel), options?: {
    fresh?: () => PressureLevel;
    overridden?: boolean;
}): PressureSampler;
/**
 * A scripted `HeadroomSampler` for tests, beside `scriptedPressureSampler`. `readings` is one reading, a list (one per
 * call, then the last one held), or a function read on every call. `fresh()` reads like the sampler unless
 * `options.fresh` models a stale shared step; `overridden()` exists only when `options.overridden` is set.
 */
export declare function scriptedHeadroomSampler(readings: HeadroomReading | readonly HeadroomReading[] | (() => HeadroomReading), options?: {
    fresh?: () => HeadroomReading;
    overridden?: boolean;
}): HeadroomSampler;
