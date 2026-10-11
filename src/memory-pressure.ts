/**
 * Memory-pressure signal and the one threshold table every consumer reads
 * (the heavy-command lease, the engine's session launches, ship-dag's
 * preflight), so their thresholds cannot drift. Nothing in the engine calls
 * this yet; later slices wire it in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

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

const SYSCTL_NAME = "kern.memorystatus_vm_pressure_level";
const LEVELS_BY_VALUE: Record<string, PressureLevel> = { "1": "normal", "2": "warning", "4": "critical" };
const SAMPLE_TTL_MS = 10_000;
const FALLBACK_MAX_AGE_MS = 60_000;
const DEFAULT_POLICY: PressurePolicy = { heavyCeiling: 4, heavyWarning: 1 };
const OVERRIDE_VALUE = "critical-as-warning";

const stderrWarn = (msg: string): void => {
  process.stderr.write(`[memory-pressure] ${msg}\n`);
};

/** Reports each distinct message once per process. */
const seen = new Set<string>();
const warnOnce = (msg: string): void => {
  if (seen.has(msg)) return;
  seen.add(msg);
  stderrWarn(msg);
};

/**
 * Reads the macOS pressure level. `null` means the darwin read failed, timed
 * out or returned an unrecognised value; `"unknown"` means no signal here.
 */
export function readMemoryPressure(
  deps: { platform?: NodeJS.Platform; sysctl?: (name: string) => string } = {},
): PressureLevel | null {
  const { platform = process.platform, sysctl = defaultSysctl } = deps;
  if (platform !== "darwin") return "unknown";
  try {
    return LEVELS_BY_VALUE[sysctl(SYSCTL_NAME).trim()] ?? null;
  } catch {
    return null;
  }
}

function defaultSysctl(name: string): string {
  return execFileSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8", timeout: 2_000 });
}

/** Heavy-command slots at a level; `critical` is always 0. */
export function heavyCapacity(level: PressureLevel, policy: PressurePolicy): number {
  if (level === "critical") return 0;
  return level === "warning" ? policy.heavyWarning : policy.heavyCeiling;
}

/** Concurrent engine sessions at a level. */
export function sessionCapacity(level: PressureLevel, maxParallel: number): number {
  if (level === "critical") return 0;
  return level === "warning" ? 1 : maxParallel;
}

/** The stop rule: critical with nothing running that could relieve it by finishing. */
export function stopAtCritical(level: PressureLevel, running: number): boolean {
  return level === "critical" && running === 0;
}

/** `CO_LEASE_SLOTS` overrides the heavy ceiling; an invalid value keeps the default and is reported. */
export function pressurePolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = warnOnce,
): PressurePolicy {
  const raw = env.CO_LEASE_SLOTS;
  if (raw === undefined) return { ...DEFAULT_POLICY };
  if (/^[1-9]\d*$/.test(raw.trim())) return { ...DEFAULT_POLICY, heavyCeiling: Number(raw.trim()) };
  warn(`ignoring invalid CO_LEASE_SLOTS=${JSON.stringify(raw)}; keeping ${DEFAULT_POLICY.heavyCeiling}`);
  return { ...DEFAULT_POLICY };
}

/** True when a reading taken at `at` is no older than `maxAgeMs` at `now`; a reading from the future (a clock step back) is not fresh. */
function isFresh(at: number, now: number, maxAgeMs: number): boolean {
  const age = now - at;
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

/** Wraps `read` in a TTL cache (default 10 s). A cached level from the future (the clock stepped back) has expired. */
export function cachedPressureSampler(
  read: () => PressureLevel,
  ttlMs: number = SAMPLE_TTL_MS,
  now: () => number = Date.now,
): PressureSampler {
  let cached: { level: PressureLevel; at: number } | undefined;
  const fresh = (): PressureLevel => {
    const level = read();
    cached = { level, at: now() };
    return level;
  };
  const sampler = (): PressureLevel =>
    cached && isFresh(cached.at, now(), ttlMs) ? cached.level : fresh();
  return Object.assign(sampler, { fresh });
}

/** Maps `critical` to `warning` only for `CO_PRESSURE_OVERRIDE=critical-as-warning`; other values are ignored with a warning. */
export function applyPressureOverride(
  level: PressureLevel,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = warnOnce,
): PressureLevel {
  const value = env.CO_PRESSURE_OVERRIDE;
  if (value === undefined) return level;
  if (value !== OVERRIDE_VALUE) {
    warn(`ignoring CO_PRESSURE_OVERRIDE=${JSON.stringify(value)}; only "${OVERRIDE_VALUE}" is recognised`);
    return level;
  }
  return level === "critical" ? "warning" : level;
}

/**
 * The lease directory, shared with the lease itself so the path is resolved in
 * one place: `CO_LEASE_DIR` as given, else `$XDG_STATE_HOME/claude-orchestrator/lease`,
 * else `<home>/.local/state/claude-orchestrator/lease`. A relative `XDG_STATE_HOME`
 * is ignored, as the XDG spec requires. `<home>` is `HOME` when absolute, else the
 * account's home from the user database (`accountHome`), so a process started
 * without `HOME` still shares the machine-wide directory. Throws when no absolute
 * home exists rather than resolve a path against the cwd.
 */
export function leaseDirectory(
  env: NodeJS.ProcessEnv = process.env,
  accountHome: () => string = () => userInfo().homedir,
): string {
  if (env.CO_LEASE_DIR) return env.CO_LEASE_DIR;
  const xdg = env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "claude-orchestrator", "lease");
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : accountHome();
  if (!isAbsolute(home)) throw new Error("cannot resolve the lease directory: no absolute XDG_STATE_HOME or HOME");
  return join(home, ".local", "state", "claude-orchestrator", "lease");
}

/**
 * The one production sampler: cached sysctl reading, override applied. A failed
 * darwin read falls back to the last good reading under 60 s old (in-process,
 * else `<lease dir>/level.json`), and otherwise reads `critical`, so a sustained
 * failure can only stop work. A reading from the future is never fresh. Throws
 * when `leaseDirectory(env)` does. `deps` exists for tests.
 */
export function defaultPressureSampler(
  env: NodeJS.ProcessEnv = process.env,
  deps: { read?: () => PressureLevel | null; now?: () => number; log?: (msg: string) => void } = {},
): PressureSampler {
  const { read = () => readMemoryPressure(), now = Date.now, log: emit = stderrWarn } = deps;
  const logged = new Set<string>();
  const log = (msg: string): void => {
    if (!logged.has(msg)) {
      logged.add(msg);
      emit(msg);
    }
  };
  const file = join(leaseDirectory(env), "level.json");
  let lastGood: { level: PressureLevel; at: number } | undefined;

  const persist = (reading: { level: PressureLevel; at: number }): void => {
    if (reading.level === "unknown" || !existsSync(leaseDirectory(env))) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(reading));
      renameSync(tmp, file);
    } catch {
      // Persistence is best-effort; the in-process reading still serves.
    }
  };

  const persisted = (): { level: PressureLevel; at: number } | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Object.values(LEVELS_BY_VALUE).includes(parsed.level) && typeof parsed.at === "number"
        ? { level: parsed.level, at: parsed.at }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const raw = (): PressureLevel => {
    const level = read();
    const at = now();
    if (level !== null) {
      lastGood = { level, at };
      persist(lastGood);
      return level;
    }
    log("memory-pressure read failed; using the last good reading, else critical");
    const candidate = [lastGood, persisted()].find((r) => r && isFresh(r.at, at, FALLBACK_MAX_AGE_MS));
    return candidate?.level ?? "critical";
  };

  return cachedPressureSampler(() => {
    const level = applyPressureOverride(raw(), env);
    if (env.CO_PRESSURE_OVERRIDE === OVERRIDE_VALUE) log(`CO_PRESSURE_OVERRIDE=${OVERRIDE_VALUE} in effect: critical reads as warning`);
    return level;
  }, SAMPLE_TTL_MS, now);
}
