/**
 * Memory-pressure signal and the one threshold table every consumer reads
 * (the heavy-command lease, the engine's session launches, ship-dag's
 * preflight), so their thresholds cannot drift.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeLeaseRecord } from "./lease-dir.js";
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
  /** True when the last level returned was mapped from `critical` by `CO_PRESSURE_OVERRIDE`; absent means never. */
  overridden?(): boolean;
}

const SYSCTL_NAME = "kern.memorystatus_vm_pressure_level";
const FREE_PCT_NAME = "kern.memorystatus_level";
const MEMSIZE_NAME = "hw.memsize";
const SWAP_NAMES = ["vm.compressor.swapper.used_bytes", "vm.compressor.swapper.allocated_bytes", "vm.compressor.swapper.swapins_total"] as const;
const LEVELS_BY_VALUE: Record<string, PressureLevel> = { "1": "normal", "2": "warning", "4": "critical" };
const SAMPLE_TTL_MS = 10_000;
/** How old the last good reading may be when a guarded read fails; shared with the headroom sampler. */
export const FALLBACK_MAX_AGE_MS = 60_000;
const DEFAULT_POLICY: PressurePolicy = { heavyCeiling: 4, heavyWarning: 1 };
/** The machine-wide ceiling of implementer sessions at step 4. */
export const DEFAULT_SESSION_SLOTS = 6;
/** The share of `hw.memsize`, in percent, the heavy class leaves to the rest of the machine. */
export const DEFAULT_RESERVE_PCT = 25;
const OVERRIDE_VALUE = "critical-as-warning";

const stderrWarn = (msg: string): void => {
  process.stderr.write(`[memory-pressure] ${msg}\n`);
};

/** Reports each distinct message once per process. */
const seen = new Set<string>();
export const warnOnce = (msg: string): void => {
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

let memsize: number | undefined;

/** Forgets the cached `hw.memsize`, so a test can read it again. */
export function resetMemsizeCache(): void {
  memsize = undefined;
}

const parseCount = (raw: string | undefined): number | undefined => (raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined);

/**
 * Reads the level and free percentage in one guarded `sysctl` call: `null` means
 * it failed, timed out or returned an unrecognised value, as for `readMemoryPressure`.
 * The swap values and `hw.memsize` (asked for until one read succeeds, then cached for the process) come
 * from a separate call that only ever leaves them absent, because `sysctl -n` with one unknown name exits 1
 * and would turn a renamed oid into a failed guarded read.
 */
export function readMemorySignals(
  deps: { platform?: NodeJS.Platform; sysctl?: (...names: string[]) => string } = {},
): MemorySignals | null {
  const { platform = process.platform, sysctl = defaultSysctl } = deps;
  if (platform !== "darwin") return { level: "unknown" };
  let signals: MemorySignals;
  try {
    const [rawLevel, rawFree] = sysctl(SYSCTL_NAME, FREE_PCT_NAME).split("\n");
    const level = LEVELS_BY_VALUE[rawLevel?.trim() ?? ""];
    const freePct = parseCount(rawFree);
    if (!level || freePct === undefined || freePct > 100) return null;
    signals = { level, freePct };
  } catch {
    return null;
  }
  try {
    const [used, allocated, swapins, size] = sysctl(...SWAP_NAMES, ...(memsize === undefined ? [MEMSIZE_NAME] : [])).split("\n").map(parseCount);
    if (used !== undefined) signals.swapUsedBytes = used;
    if (allocated !== undefined) signals.swapAllocatedBytes = allocated;
    if (swapins !== undefined) signals.swapinsTotal = swapins;
    if (size) memsize = size;
  } catch {
    // Swap values and the memory size are optional; the step never depends on them.
  }
  if (memsize !== undefined) signals.memsizeBytes = memsize;
  return signals;
}

/** The child's stderr is discarded: inherited, a failing `sysctl` would write to the caller's stderr past the lease's `warn` seam. */
function defaultSysctl(...names: string[]): string {
  return execFileSync("/usr/sbin/sysctl", ["-n", ...names], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
}

/** Heavy-command slots at a level; `critical` is always 0. */
export function heavyCapacity(level: PressureLevel, policy: PressurePolicy): number {
  if (level === "critical") return 0;
  return level === "warning" ? policy.heavyWarning : policy.heavyCeiling;
}

/** Concurrent engine sessions at a level. In the engine this bounds pipelines, not only live `claude` processes: a pipeline keeps its slot through its post-session check and retries. */
export function sessionCapacity(level: PressureLevel, maxParallel: number): number {
  if (level === "critical") return 0;
  return level === "warning" ? 1 : maxParallel;
}

/**
 * The stop rule: critical with nothing running that could relieve it by finishing.
 * `running` counts only other work that could finish and relieve pressure, never the caller's own slot, pipeline or lease holder: counting itself means `running` is never 0 and a wait at critical never ends.
 */
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

/** `CO_LEASE_SESSION_SLOTS` replaces the session ceiling (and caps the lower steps); an invalid value keeps the default and is reported. */
export function sessionSlotsFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = warnOnce): number {
  const raw = env.CO_LEASE_SESSION_SLOTS;
  if (raw === undefined) return DEFAULT_SESSION_SLOTS;
  if (/^[1-9]\d*$/.test(raw.trim())) return Number(raw.trim());
  warn(`ignoring invalid CO_LEASE_SESSION_SLOTS=${JSON.stringify(raw)}; keeping ${DEFAULT_SESSION_SLOTS}`);
  return DEFAULT_SESSION_SLOTS;
}

/** `CO_LEASE_RESERVE_PCT`, an integer from 0 to 99; an invalid value keeps the default and is reported. */
export function reservePctFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = warnOnce): number {
  const raw = env.CO_LEASE_RESERVE_PCT;
  if (raw === undefined) return DEFAULT_RESERVE_PCT;
  if (/^\d{1,2}$/.test(raw.trim())) return Number(raw.trim());
  warn(`ignoring invalid CO_LEASE_RESERVE_PCT=${JSON.stringify(raw)}; keeping ${DEFAULT_RESERVE_PCT}`);
  return DEFAULT_RESERVE_PCT;
}

/** The bytes of `memsizeBytes` the heavy class may budget: what is left after the `reservePct` reserve. */
export const usableBytes = (memsizeBytes: number, reservePct: number): number => Math.floor((memsizeBytes * (100 - reservePct)) / 100);

/** True when a reading taken at `at` is no older than `maxAgeMs` at `now`; a reading from the future (a clock step back) is not fresh. */
export function isFresh(at: number, now: number, maxAgeMs: number): boolean {
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
 * one place: `CO_LEASE_DIR` when absolute, else `$XDG_STATE_HOME/claude-orchestrator/lease`,
 * else `<home>/.local/state/claude-orchestrator/lease`. A relative `XDG_STATE_HOME`
 * is ignored, as the XDG spec requires. `<home>` is `HOME` when absolute, else the
 * account's home from the user database (`accountHome`), so a process started
 * without `HOME` still shares the machine-wide directory. Throws on a relative
 * `CO_LEASE_DIR`, or when no absolute home exists, rather than resolve a path
 * against the cwd.
 */
export function leaseDirectory(
  env: NodeJS.ProcessEnv = process.env,
  accountHome: () => string = () => userInfo().homedir,
): string {
  if (env.CO_LEASE_DIR) {
    if (!isAbsolute(env.CO_LEASE_DIR)) throw new Error(`CO_LEASE_DIR must be an absolute path, got ${JSON.stringify(env.CO_LEASE_DIR)}`);
    return env.CO_LEASE_DIR;
  }
  const xdg = env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "claude-orchestrator", "lease");
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : accountHome();
  if (!isAbsolute(home)) throw new Error("cannot resolve the lease directory: no absolute XDG_STATE_HOME or HOME");
  return join(home, ".local", "state", "claude-orchestrator", "lease");
}

/** Best-effort write of `<dir>/level.json` (`{ level, at }`); an `unknown` level is never written. */
export function persistLevel(dir: string, reading: { level: PressureLevel; at: number }): void {
  if (reading.level === "unknown") return;
  try {
    writeLeaseRecord(dir, "level.json", JSON.stringify(reading));
  } catch {
    // Persistence is best-effort; the in-process reading still serves.
  }
}

/** The reading `persistLevel` left in `<dir>/level.json`, or `undefined` when it is missing or malformed. */
export function persistedLevel(dir: string): { level: PressureLevel; at: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "level.json"), "utf8"));
    return Object.values(LEVELS_BY_VALUE).includes(parsed.level) && typeof parsed.at === "number"
      ? { level: parsed.level, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
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
  const { read = () => readMemoryPressure(), now = Date.now, log: emit = warnOnce } = deps;
  const logged = new Set<string>();
  const log = (msg: string): void => {
    if (!logged.has(msg)) {
      logged.add(msg);
      emit(msg);
    }
  };
  const dir = leaseDirectory(env);
  let lastGood: { level: PressureLevel; at: number } | undefined;

  const raw = (): PressureLevel => {
    const level = read();
    const at = now();
    if (level !== null) {
      lastGood = { level, at };
      persistLevel(dir, lastGood);
      return level;
    }
    log("read failed; using the last good reading, else critical");
    const candidate = [lastGood, persistedLevel(dir)].find((r) => r && isFresh(r.at, at, FALLBACK_MAX_AGE_MS));
    return candidate?.level ?? "critical";
  };

  let overridden = false;
  const sampler = cachedPressureSampler(() => {
    const reading = raw();
    const level = applyPressureOverride(reading, env, log);
    overridden = level !== reading;
    if (overridden) log(`CO_PRESSURE_OVERRIDE=${OVERRIDE_VALUE} in effect: critical reads as warning`);
    return level;
  }, SAMPLE_TTL_MS, now);
  return Object.assign(sampler, { overridden: () => overridden });
}
