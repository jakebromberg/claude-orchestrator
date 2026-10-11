/** `unknown` means this platform has no signal; a failed darwin read is `null`, never `unknown`. */
export type PressureLevel = "normal" | "warning" | "critical" | "unknown";
export interface PressurePolicy {
    heavyCeiling: number;
    heavyWarning: number;
}
/** A cached sampler; `fresh()` bypasses and refreshes the cache. */
export interface PressureSampler {
    (): PressureLevel;
    fresh(): PressureLevel;
}
/**
 * Reads the macOS pressure level. `null` means the darwin read failed, timed
 * out or returned an unrecognised value; `"unknown"` means no signal here.
 */
export declare function readMemoryPressure(deps?: {
    platform?: NodeJS.Platform;
    sysctl?: (name: string) => string;
}): PressureLevel | null;
/** Heavy-command slots at a level; `critical` is always 0. */
export declare function heavyCapacity(level: PressureLevel, policy: PressurePolicy): number;
/** Concurrent engine sessions at a level. */
export declare function sessionCapacity(level: PressureLevel, maxParallel: number): number;
/** The stop rule: critical with nothing running that could relieve it by finishing. */
export declare function stopAtCritical(level: PressureLevel, running: number): boolean;
/** `CO_LEASE_SLOTS` overrides the heavy ceiling; an invalid value keeps the default and is reported. */
export declare function pressurePolicyFromEnv(env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): PressurePolicy;
/** Wraps `read` in a TTL cache (default 10 s). A cached level from the future (the clock stepped back) has expired. */
export declare function cachedPressureSampler(read: () => PressureLevel, ttlMs?: number, now?: () => number): PressureSampler;
/** Maps `critical` to `warning` only for `CO_PRESSURE_OVERRIDE=critical-as-warning`; other values are ignored with a warning. */
export declare function applyPressureOverride(level: PressureLevel, env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): PressureLevel;
/**
 * The lease directory, shared with the lease itself so the path is resolved in
 * one place: `CO_LEASE_DIR` as given, else `$XDG_STATE_HOME/claude-orchestrator/lease`,
 * else `<home>/.local/state/claude-orchestrator/lease`. A relative `XDG_STATE_HOME`
 * is ignored, as the XDG spec requires. `<home>` is `HOME` when absolute, else the
 * account's home from the user database (`accountHome`), so a process started
 * without `HOME` still shares the machine-wide directory. Throws when no absolute
 * home exists rather than resolve a path against the cwd.
 */
export declare function leaseDirectory(env?: NodeJS.ProcessEnv, accountHome?: () => string): string;
/**
 * The one production sampler: cached sysctl reading, override applied. A failed
 * darwin read falls back to the last good reading under 60 s old (in-process,
 * else `<lease dir>/level.json`), and otherwise reads `critical`, so a sustained
 * failure can only stop work. A reading from the future is never fresh. Throws
 * when `leaseDirectory(env)` does. `deps` exists for tests.
 */
export declare function defaultPressureSampler(env?: NodeJS.ProcessEnv, deps?: {
    read?: () => PressureLevel | null;
    now?: () => number;
    log?: (msg: string) => void;
}): PressureSampler;
