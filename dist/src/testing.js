export { InMemoryStatusStore, InMemoryMetadataStore } from "./status.js";
export { createSilentLogger } from "./log.js";
/**
 * A scripted `PressureSampler` for tests. `levels` is one level, a list (one level per reading, then the last one
 * held), or a function read on every call. `fresh()` reads like the sampler unless `options.fresh` models a stale
 * cache; `overridden()` exists only when `options.overridden` is set.
 */
export function scriptedPressureSampler(levels, options = {}) {
    let i = 0;
    const script = typeof levels === "string" ? [levels] : levels;
    const read = typeof script === "function" ? script : () => script[Math.min(i++, script.length - 1)];
    const { fresh = read, overridden } = options;
    return Object.assign(read, { fresh }, overridden === undefined ? {} : { overridden: () => overridden });
}
//# sourceMappingURL=testing.js.map