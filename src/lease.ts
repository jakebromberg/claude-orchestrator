/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under `heavyCapacity(level, policy)`. Liveness is a live
 * wrapper PID or a live child PID, so a crashed or killed holder cannot leak a
 * slot. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLockOnce } from "./file-lock.js";
import {
  defaultPressureSampler,
  heavyCapacity,
  leaseDirectory,
  pressureOverrideInEffect,
  pressurePolicyFromEnv,
  type PressureLevel,
  type PressurePolicy,
  type PressureSampler,
} from "./memory-pressure.js";

const MUTEX_STALE_MS = 10_000;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
const FAIL_OPEN_MS = 30_000;
const POLL_MS = 3_000;
const COMMAND_MAX = 200;

type ReapReason = "dead" | "orphan-bound" | "corrupt";

export type LeaseEvent =
  | { type: "acquire"; id: string; waitedMs: number; level: PressureLevel; live: number; capacity: number }
  | { type: "release"; id: string; exitCode?: number }
  | { type: "reap"; id: string; reason: ReapReason }
  | { type: "timeout"; refused: "max-wait" | "stopped"; waitedMs: number }
  | { type: "fail-open"; reason: "mutex-busy" | "io-error"; waitedMs: number };

export interface LeaseOptions {
  dir: string;
  level: PressureSampler;
  policy: PressurePolicy;
  isAlive?(pid: number): boolean;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
  /** The `CO_LEASE_HOLDER` id this process inherited; a live one admits a nested acquire at once. */
  inheritedHolderId?: string;
  /** True when `CO_PRESSURE_OVERRIDE=critical-as-warning` is in effect; a `warning` level is then recorded as override-produced. */
  override?: boolean;
  /** A throw is warned about once per callback and never changes what the lease does. */
  onEvent?(e: LeaseEvent): void;
  warn?(msg: string): void;
}

/** What a holder file records about the request; `label` replaces `command` when given. */
export interface HolderMeta {
  command: string;
  label?: string;
  cwd: string;
}

interface HolderRecord {
  id: string;
  pid: number;
  childPid?: number;
  command: string;
  cwd: string;
  startedAt: number;
  level: PressureLevel;
  override?: true;
}

/** A live holder as `leaseStatus` reports it. */
export interface HolderInfo extends HolderRecord {
  ageSec: number;
}

export interface LeaseStatus {
  level: PressureLevel;
  capacity: number;
  live: HolderInfo[];
}

export interface LeaseHandle {
  /** `null` for an unleased (fail-open) handle. */
  id: string | null;
  leased: boolean;
  /** `live` counts this holder. */
  admission: { waitedMs: number; level: PressureLevel; live: number; capacity: number };
  /** Env for the child command; the holder id is never put in `process.env`. */
  childEnv(): Record<string, string>;
  setChildPid(pid: number): void;
  release(outcome?: { exitCode?: number }): void;
}

export interface LeaseRefusal {
  refused: "max-wait" | "stopped";
  waitedMs: number;
  level: PressureLevel;
  live: number;
}

type Attempt =
  | { kind: "admitted"; handle: LeaseHandle }
  | { kind: "full" | "busy" | "error"; level: PressureLevel; capacity: number };

const holdersDir = (dir: string): string => join(dir, "holders");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The single liveness rule; the heartbeat (#112) and CO-5's detached holders
 * (#105) extend it. Until the heartbeat lands, a recycled wrapper PID can pin a
 * slot. `null` is a file that is not a holder record.
 */
function verdict(rec: HolderRecord | null, nowMs: number, alive: (pid: number) => boolean): "live" | ReapReason {
  if (!rec) return "corrupt";
  if (alive(rec.pid)) return "live";
  if (rec.childPid && alive(rec.childPid)) return Math.abs(nowMs - rec.startedAt) > ORPHAN_MAX_MS ? "orphan-bound" : "live";
  return "dead";
}

/** `read()`, or `undefined` when the path is gone. Any other error is an I/O error and throws. */
function unlessGone<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process. */
const isPid = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

function parseHolder(text: string): HolderRecord | null {
  try {
    const rec = JSON.parse(text);
    return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" ? rec : null;
  } catch {
    return null;
  }
}

/** Throws on an I/O error; a file released since the `readdir` is skipped, and only an unparseable or malformed one is corrupt. */
function scanHolders(opts: LeaseOptions): { live: HolderInfo[]; dead: { id: string; reason: ReapReason }[] } {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = holdersDir(opts.dir);
  const found = { live: [] as HolderInfo[], dead: [] as { id: string; reason: ReapReason }[] };
  const names = unlessGone(() => readdirSync(dir)) ?? [];
  const nowMs = now();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const text = unlessGone(() => readFileSync(join(dir, name), "utf8"));
    if (text === undefined) continue;
    const rec = parseHolder(text);
    const v = verdict(rec, nowMs, isAlive);
    if (v === "live") found.live.push({ ...rec!, ageSec: Math.round((nowMs - rec!.startedAt) / 1000) });
    else found.dead.push({ id: name.slice(0, -".json".length), reason: v });
  }
  return found;
}

// Any shell word that starts `NAME=` (or opens a quote, then `NAME=`), wherever it is. Its value runs through quoted
// parts (an unterminated quote runs to the end), backslash escapes and `$( … )` to the end of the word; it may over-redact.
const ASSIGNMENT = /(?<=^|[\s;&|()<>{}`"'])([A-Za-z_]\w*=)(?:[^\s;&|()<>`'"\\$]|\$(?:\([^)]*\)?)?|\\[\s\S]?|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|`[^`]*`?)*/g;

/** Redacts the value of every `NAME=value` word, then truncates. */
function recordedCommand({ command, label }: HolderMeta): string {
  return (label ?? command.replace(ASSIGNMENT, "$1…")).slice(0, COMMAND_MAX);
}

function createHolder(opts: LeaseOptions, meta: HolderMeta, command: string, admission: LeaseHandle["admission"]): LeaseHandle {
  const now = opts.now ?? Date.now;
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const file = join(holdersDir(opts.dir), `${id}.json`);
  const rec: HolderRecord = { id, pid: process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
  if (opts.override && admission.level === "warning") rec.override = true;
  const write = (): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  write();
  let released = false;
  return {
    id,
    leased: true,
    admission,
    childEnv: () => ({ CO_LEASE_HOLDER: id }),
    setChildPid(pid) {
      if (released) return;
      rec.childPid = pid;
      try {
        write();
      } catch {
        // The previous record still names this holder.
      }
    },
    release(outcome) {
      if (released) return;
      released = true;
      try {
        unlinkSync(file);
      } catch {
        // Already reaped.
      }
      emit(opts, { type: "release", id, exitCode: outcome?.exitCode });
    },
  };
}

function borrowedHandle(id: string, level: PressureLevel, capacity: number, live: number): LeaseHandle {
  return { id, leased: true, admission: { waitedMs: 0, level, live, capacity }, childEnv: () => ({ CO_LEASE_HOLDER: id }), setChildPid() {}, release() {} };
}

/**
 * Creates the lease and holders directories (mode 0700), tightens one this user owns to 0700, and throws
 * (an I/O error) on one that is a symlink, not a directory, or another user's. A platform without uids
 * (Windows) skips the ownership check.
 */
function ensureOwnDirs(dir: string): void {
  for (const d of [dir, holdersDir(dir)]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`lease: ${d} is not a directory this user owns`);
    if (st.mode & 0o077) chmodSync(d, 0o700);
  }
}

/**
 * One admission attempt: sample the level, then count and write holders under the mutex. Caller code
 * (`warn`, `onEvent`) runs only after the mutex is released, so a slow callback cannot outlive its staleness window.
 */
function attempt(opts: LeaseOptions, meta: HolderMeta, waitedMs: number): Attempt {
  const level = opts.level();
  const capacity = heavyCapacity(level, opts.policy);
  const command = recordedCommand(meta);
  const reaped: { id: string; reason: ReapReason }[] = [];
  let r: Attempt;
  try {
    ensureOwnDirs(opts.dir);
    const scan = scanHolders(opts);
    if (opts.inheritedHolderId && scan.live.some((h) => h.id === opts.inheritedHolderId)) {
      return { kind: "admitted", handle: borrowedHandle(opts.inheritedHolderId, level, capacity, scan.live.length) };
    }
    const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
    if (!lock) return { kind: "busy", level, capacity };
    try {
      const { live, dead } = scanHolders(opts);
      for (const d of dead) {
        rmSync(join(holdersDir(opts.dir), `${d.id}.json`), { force: true });
        reaped.push(d);
      }
      const admission = { waitedMs, level, live: live.length + 1, capacity };
      if (live.length < capacity) r = { kind: "admitted", handle: createHolder(opts, meta, command, admission) };
      else r = { kind: "full", level, capacity };
    } finally {
      lock.release();
    }
  } catch {
    r = { kind: "error", level, capacity };
  }
  for (const { id, reason } of reaped) {
    if (reason === "orphan-bound") warn(opts, `lease: reaping holder ${id}: its child outlived the 2 h orphan bound`);
    emit(opts, { type: "reap", id, reason });
  }
  if (r.kind === "admitted") emit(opts, { type: "acquire", id: r.handle.id!, ...r.handle.admission });
  return r;
}

const defaultWarn = (msg: string): void => {
  process.stderr.write(`[lease] ${msg}\n`);
};

const failedCallbacks = new WeakSet<object>();

/** Runs a caller's `onEvent` or `warn`. A throw is warned about once per callback and never changes what the lease does. */
function guarded<T>(opts: LeaseOptions, callback: ((arg: T) => void) | undefined, arg: T): void {
  try {
    callback?.call(opts, arg);
  } catch (err) {
    if (!callback || failedCallbacks.has(callback)) return;
    failedCallbacks.add(callback);
    warn(opts, `lease: a callback threw and is ignored: ${String(err)}`);
  }
}

const warn = (opts: LeaseOptions, msg: string): void => guarded(opts, opts.warn ?? defaultWarn, msg);
const emit = (opts: LeaseOptions, e: LeaseEvent): void => guarded(opts, opts.onEvent, e);

function failOpen(opts: LeaseOptions, level: PressureLevel, capacity: number, waitedMs: number, reason: "mutex-busy" | "io-error"): LeaseHandle {
  warn(opts, `lease unavailable (${reason}); running unleased`);
  emit(opts, { type: "fail-open", reason, waitedMs });
  return { id: null, leased: false, admission: { waitedMs, level, live: 0, capacity }, childEnv: () => ({}), setChildPid() {}, release() {} };
}

/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. */
export function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null {
  const r = attempt(opts, meta, 0);
  if (r.kind === "admitted") return r.handle;
  return r.kind === "error" && r.level !== "critical" ? failOpen(opts, r.level, r.capacity, 0, "io-error") : null;
}

/** Live holders, or none when the directory cannot be read. */
function statusOf(opts: LeaseOptions, level: PressureLevel): LeaseStatus {
  const capacity = heavyCapacity(level, opts.policy);
  try {
    return { level, capacity, live: scanHolders(opts).live };
  } catch {
    return { level, capacity, live: [] };
  }
}

/**
 * Polls (3 s ± 1 s, never spinning) until admitted. `stopWhen` is checked on
 * every poll, and a stop is confirmed with a `level.fresh()` re-read before it
 * is returned, so one stale cached sample cannot end a wave.
 */
export async function acquireLease(
  opts: LeaseOptions,
  meta: HolderMeta,
  wait: { maxWaitMs?: number; onWait?(s: LeaseStatus): void; stopWhen?(s: LeaseStatus): boolean } = {},
): Promise<LeaseHandle | LeaseRefusal> {
  const { now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = POLL_MS } = opts;
  const start = now();
  let busySince: number | undefined;
  for (;;) {
    const waitedMs = now() - start;
    const r = attempt(opts, meta, waitedMs);
    if (r.kind === "admitted") return r.handle;
    busySince = r.kind === "busy" ? (busySince ?? now()) : undefined;
    if (r.level !== "critical") {
      if (r.kind === "error") return failOpen(opts, r.level, r.capacity, waitedMs, "io-error");
      if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS) return failOpen(opts, r.level, r.capacity, waitedMs, "mutex-busy");
    }
    const status = r.kind === "error" ? { level: r.level, capacity: r.capacity, live: [] } : statusOf(opts, r.level);
    const refuse = (refused: LeaseRefusal["refused"], level: PressureLevel, live: number): LeaseRefusal => {
      emit(opts, { type: "timeout", refused, waitedMs });
      return { refused, waitedMs, level, live };
    };
    if (wait.stopWhen?.(status)) {
      const level = opts.level.fresh();
      if (wait.stopWhen({ ...status, level, capacity: heavyCapacity(level, opts.policy) })) return refuse("stopped", level, status.live.length);
    }
    if (wait.maxWaitMs !== undefined && waitedMs >= wait.maxWaitMs) return refuse("max-wait", r.level, status.live.length);
    wait.onWait?.(status);
    const jittered = Math.round(pollMs * (2 / 3 + Math.random() * (2 / 3)));
    await sleep(wait.maxWaitMs === undefined ? jittered : Math.min(jittered, wait.maxWaitMs - waitedMs));
  }
}

/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export function leaseStatus(opts: LeaseOptions): LeaseStatus {
  return statusOf(opts, opts.level());
}

/** Production wiring: the real lease directory and the engine's own sampler and policy. Creates nothing on disk. */
export function defaultLeaseOptions(env: NodeJS.ProcessEnv = process.env): LeaseOptions {
  return {
    dir: leaseDirectory(env),
    level: defaultPressureSampler(env),
    policy: pressurePolicyFromEnv(env),
    inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
    override: pressureOverrideInEffect(env),
  };
}
