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
    /** True when the last level returned was mapped from `critical` by `CO_PRESSURE_OVERRIDE`; absent means never. */
    overridden?(): boolean;
}
/** How old the last good reading may be when a guarded read fails; shared with the headroom sampler. */
export declare const FALLBACK_MAX_AGE_MS = 60000;
/** The machine-wide ceiling of implementer sessions at step 4. */
export declare const DEFAULT_SESSION_SLOTS = 6;
/** The share of `hw.memsize`, in percent, the heavy class leaves to the rest of the machine. */
export declare const DEFAULT_RESERVE_PCT = 25;
export declare const warnOnce: (msg: string) => void;
/**
 * Reads the macOS pressure level. `null` means the darwin read failed, timed
 * out or returned an unrecognised value; `"unknown"` means no signal here.
 */
export declare function readMemoryPressure(deps?: {
    platform?: NodeJS.Platform;
    sysctl?: (name: string) => string;
}): PressureLevel | null;
/** What the kernel publishes about memory: the pressure level, the free percentage and, when readable, swap use. */
export interface MemorySignals {
    level: PressureLevel;
    /** `kern.memorystatus_level`; present whenever the level was read (a failed guarded read returns `null`, not signals without it), absent only when the level is `unknown`. */
    freePct?: number;
    swapUsedBytes?: number;
    swapAllocatedBytes?: number;
    swapinsTotal?: number;
    /** `hw.memsize`, read once per process and carried by every later reading; absent until a read of it succeeds. */
    memsizeBytes?: number;
}
/** Forgets the cached `hw.memsize`, so a test can read it again. */
export declare function resetMemsizeCache(): void;
/**
 * Reads the level and free percentage in one guarded `sysctl` call: `null` means
 * it failed, timed out or returned an unrecognised value, as for `readMemoryPressure`.
 * The swap values and `hw.memsize` (asked for until one read succeeds, then cached for the process) come
 * from a separate call that only ever leaves them absent, because `sysctl -n` with one unknown name exits 1
 * and would turn a renamed oid into a failed guarded read.
 */
export declare function readMemorySignals(deps?: {
    platform?: NodeJS.Platform;
    sysctl?: (...names: string[]) => string;
}): MemorySignals | null;
/** Heavy-command slots at a level; `critical` is always 0. */
export declare function heavyCapacity(level: PressureLevel, policy: PressurePolicy): number;
/** Concurrent engine sessions at a level. In the engine this bounds pipelines, not only live `claude` processes: a pipeline keeps its slot through its post-session check and retries. */
export declare function sessionCapacity(level: PressureLevel, maxParallel: number): number;
/**
 * The stop rule: critical with nothing running that could relieve it by finishing.
 * `running` counts only other work that could finish and relieve pressure, never the caller's own slot, pipeline or lease holder: counting itself means `running` is never 0 and a wait at critical never ends.
 */
export declare function stopAtCritical(level: PressureLevel, running: number): boolean;
/** `CO_LEASE_SLOTS` overrides the heavy ceiling; an invalid value keeps the default and is reported. */
export declare function pressurePolicyFromEnv(env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): PressurePolicy;
/** `CO_LEASE_SESSION_SLOTS` replaces the session ceiling (and caps the lower steps); an invalid value keeps the default and is reported. */
export declare function sessionSlotsFromEnv(env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): number;
/** `CO_LEASE_RESERVE_PCT`, an integer from 0 to 99; an invalid value keeps the default and is reported. */
export declare function reservePctFromEnv(env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): number;
/** The bytes of `memsizeBytes` the heavy class may budget: what is left after the `reservePct` reserve. */
export declare const usableBytes: (memsizeBytes: number, reservePct: number) => number;
/** Free bytes as `memsizeBytes × freePct / 100`; `undefined` when either is absent, never 0. */
export declare const freeBytes: (s: MemorySignals) => number | undefined;
/** True when a reading taken at `at` is no older than `maxAgeMs` at `now`; a reading from the future (a clock step back) is not fresh. */
export declare function isFresh(at: number, now: number, maxAgeMs: number): boolean;
/** Wraps `read` in a TTL cache (default 10 s). A cached level from the future (the clock stepped back) has expired. */
export declare function cachedPressureSampler(read: () => PressureLevel, ttlMs?: number, now?: () => number): PressureSampler;
/** Maps `critical` to `warning` only for `CO_PRESSURE_OVERRIDE=critical-as-warning`; other values are ignored with a warning. */
export declare function applyPressureOverride(level: PressureLevel, env?: NodeJS.ProcessEnv, warn?: (msg: string) => void): PressureLevel;
/**
 * The lease directory, shared with the lease itself so the path is resolved in
 * one place: `CO_LEASE_DIR` when absolute, else `$XDG_STATE_HOME/claude-orchestrator/lease`,
 * else `<home>/.local/state/claude-orchestrator/lease`. A relative `XDG_STATE_HOME`
 * is ignored, as the XDG spec requires. `<home>` is `HOME` when absolute, else the
 * account's home from the user database (`accountHome`), so a process started
 * without `HOME` still shares the machine-wide directory. Throws on a relative
 * `CO_LEASE_DIR`, or when no absolute home exists, rather than resolve a path
 * against the cwd.
 */
export declare function leaseDirectory(env?: NodeJS.ProcessEnv, accountHome?: () => string): string;
/** Best-effort write of `<dir>/level.json` (`{ level, at }`); an `unknown` level is never written. */
export declare function persistLevel(dir: string, reading: {
    level: PressureLevel;
    at: number;
}): void;
/** The reading `persistLevel` left in `<dir>/level.json`, or `undefined` when it is missing or malformed. */
export declare function persistedLevel(dir: string): {
    level: PressureLevel;
    at: number;
} | undefined;
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
