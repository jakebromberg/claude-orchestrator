/**
 * Memory-pressure signal and the one threshold table every consumer reads
 * (the heavy-command lease, the engine's session launches, ship-dag's
 * preflight), so their thresholds cannot drift. Nothing in the engine calls
 * this yet; later slices wire it in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SYSCTL_NAME = "kern.memorystatus_vm_pressure_level";
const LEVELS_BY_VALUE = { "1": "normal", "2": "warning", "4": "critical" };
const SAMPLE_TTL_MS = 10_000;
const FALLBACK_MAX_AGE_MS = 60_000;
const DEFAULT_POLICY = { heavyCeiling: 4, heavyWarning: 1 };
const OVERRIDE_VALUE = "critical-as-warning";
const stderrWarn = (msg) => {
    process.stderr.write(`[memory-pressure] ${msg}\n`);
};
/** Reports each distinct message once per process. */
const seen = new Set();
const warnOnce = (msg) => {
    if (seen.has(msg))
        return;
    seen.add(msg);
    stderrWarn(msg);
};
/**
 * Reads the macOS pressure level. `null` means the darwin read failed, timed
 * out or returned an unrecognised value; `"unknown"` means no signal here.
 */
export function readMemoryPressure(deps = {}) {
    const { platform = process.platform, sysctl = defaultSysctl } = deps;
    if (platform !== "darwin")
        return "unknown";
    try {
        return LEVELS_BY_VALUE[sysctl(SYSCTL_NAME).trim()] ?? null;
    }
    catch {
        return null;
    }
}
function defaultSysctl(name) {
    return execFileSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8", timeout: 2_000 });
}
/** Heavy-command slots at a level; `critical` is always 0. */
export function heavyCapacity(level, policy) {
    if (level === "critical")
        return 0;
    return level === "warning" ? policy.heavyWarning : policy.heavyCeiling;
}
/** Concurrent engine sessions at a level. */
export function sessionCapacity(level, maxParallel) {
    if (level === "critical")
        return 0;
    return level === "warning" ? 1 : maxParallel;
}
/** The stop rule: critical with nothing running that could relieve it by finishing. */
export function stopAtCritical(level, running) {
    return level === "critical" && running === 0;
}
/** `CO_LEASE_SLOTS` overrides the heavy ceiling; an invalid value keeps the default and is reported. */
export function pressurePolicyFromEnv(env = process.env, warn = warnOnce) {
    const raw = env.CO_LEASE_SLOTS;
    if (raw === undefined)
        return { ...DEFAULT_POLICY };
    if (/^[1-9]\d*$/.test(raw.trim()))
        return { ...DEFAULT_POLICY, heavyCeiling: Number(raw.trim()) };
    warn(`ignoring invalid CO_LEASE_SLOTS=${JSON.stringify(raw)}; keeping ${DEFAULT_POLICY.heavyCeiling}`);
    return { ...DEFAULT_POLICY };
}
/** Wraps `read` in a TTL cache (default 10 s). */
export function cachedPressureSampler(read, ttlMs = SAMPLE_TTL_MS, now = Date.now) {
    let cached;
    const fresh = () => {
        const level = read();
        cached = { level, at: now() };
        return level;
    };
    const sampler = () => cached && now() - cached.at < ttlMs ? cached.level : fresh();
    return Object.assign(sampler, { fresh });
}
/** Maps `critical` to `warning` only for `CO_PRESSURE_OVERRIDE=critical-as-warning`; other values are ignored with a warning. */
export function applyPressureOverride(level, env = process.env, warn = warnOnce) {
    const value = env.CO_PRESSURE_OVERRIDE;
    if (value === undefined)
        return level;
    if (value !== OVERRIDE_VALUE) {
        warn(`ignoring CO_PRESSURE_OVERRIDE=${JSON.stringify(value)}; only "${OVERRIDE_VALUE}" is recognised`);
        return level;
    }
    return level === "critical" ? "warning" : level;
}
/** The lease directory, shared with the lease itself so the path is resolved in one place. */
export function leaseDirectory(env = process.env) {
    if (env.CO_LEASE_DIR)
        return env.CO_LEASE_DIR;
    const state = env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state");
    return join(state, "claude-orchestrator", "lease");
}
/**
 * The one production sampler: cached sysctl reading, override applied. A failed
 * darwin read falls back to the last good reading under 60 s old (in-process,
 * else `<lease dir>/level.json`), and otherwise reads `critical`, so a sustained
 * failure can only stop work. `deps` exists for tests.
 */
export function defaultPressureSampler(env = process.env, deps = {}) {
    const { read = () => readMemoryPressure(), now = Date.now, log: emit = stderrWarn } = deps;
    const logged = new Set();
    const log = (msg) => {
        if (!logged.has(msg)) {
            logged.add(msg);
            emit(msg);
        }
    };
    const file = join(leaseDirectory(env), "level.json");
    let lastGood;
    const persist = (reading) => {
        if (reading.level === "unknown" || !existsSync(leaseDirectory(env)))
            return;
        try {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(reading));
            renameSync(tmp, file);
        }
        catch {
            // Persistence is best-effort; the in-process reading still serves.
        }
    };
    const persisted = () => {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            return Object.values(LEVELS_BY_VALUE).includes(parsed.level)
                ? { level: parsed.level, at: Number(parsed.at) }
                : undefined;
        }
        catch {
            return undefined;
        }
    };
    const raw = () => {
        const level = read();
        const at = now();
        if (level !== null) {
            lastGood = { level, at };
            persist(lastGood);
            return level;
        }
        log("memory-pressure read failed; using the last good reading, else critical");
        const candidate = [lastGood, persisted()].find((r) => r && at - r.at < FALLBACK_MAX_AGE_MS);
        return candidate?.level ?? "critical";
    };
    return cachedPressureSampler(() => {
        const level = applyPressureOverride(raw(), env);
        if (env.CO_PRESSURE_OVERRIDE === OVERRIDE_VALUE)
            log(`CO_PRESSURE_OVERRIDE=${OVERRIDE_VALUE} in effect: critical reads as warning`);
        return level;
    }, SAMPLE_TTL_MS, now);
}
//# sourceMappingURL=memory-pressure.js.map