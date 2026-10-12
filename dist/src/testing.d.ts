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
