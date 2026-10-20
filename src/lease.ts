/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under the heavy capacity of the headroom step (`headroomCapacity(step, ceiling)`;
 * the step derived from the level when only a `level` sampler is given), or, when the machine's memory is known, while the
 * summed memory weights of the live holders and the request fit the byte budget (`heavyBudget`: free memory less the reserve, plus the weight of holders past the ramp window; the step's share of the usable bytes without a free reading). Liveness is a live
 * heartbeat (the holder file's mtime, refreshed every 30 s) or a live child PID,
 * so a crashed or killed holder cannot leak a slot. A detached holder (hook mode) is live while its session PID is
 * alive and its `expiresAt` has not passed. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins. A second holder class, `sessions/`, is the machine-wide pool of an
 * engine's implementer sessions (`acquireSessionLease`), on the same tickets and holders with heartbeat-only liveness.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { sweepDeadTemps, writeFileAtomic } from "./atomic-write.js";
import { isWithinWindow, tryLockOnce } from "./file-lock.js";
import { headroomCapacity, heavyBudget, MAX_STEP, RAMP_MS, sessionHeadroomCapacity, type FreeBudget } from "./headroom.js";
import { defaultHeadroomSampler, levelView, type HeadroomReading, type HeadroomSampler } from "./headroom-sampler.js";
import { ensureOwnSubdir, isOwnDir, readLeaseRecord, readOwnFile } from "./lease-dir.js";
import { leaseEventSink } from "./lease-events.js";
import {
  DEFAULT_RESERVE_PCT,
  DEFAULT_SESSION_SLOTS,
  freeBytes,
  leaseDirectory,
  pressurePolicyFromEnv,
  reservePctFromEnv,
  sessionSlotsFromEnv,
  usableBytes,
  type MemorySignals,
  type PressureLevel,
  type PressurePolicy,
  type PressureSampler,
} from "./memory-pressure.js";
import { describeBoundedFailure } from "./bounded-failure.js";
import { isPid, pidAlive, PS_TIMEOUT_MS, psField, signalGroup } from "./ps.js";
import { isLeaseRecord, leaseSuspension, readSuspensions, removeLeaseSuspension, removeSuspension, suspensionOf, writeSuspension, type SuspensionRecord } from "./suspensions.js";

export { ensureOwnSubdir, isOwnDir, isPid, pidAlive };

const MUTEX_STALE_MS = 10_000;

/**
 * Bound on the default `LeaseOptions.processCommand` (a `ps` call): `attempt()` continues at most one dead owner's group,
 * so an acquire, which the engine's post-check makes on its event loop, blocks for one lookup at most. Re-exported by `sync-budget.ts`.
 */
export const PROCESS_COMMAND_TIMEOUT_MS = PS_TIMEOUT_MS;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
/** A holder's mtime heartbeat period, and how old a beat may be before the holder is reaped; a blocking stretch in an engine that holds a session slot must fit in the difference (`__tests__/sync-call-budget.test.ts`). */
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_STALE_MS = 90_000;
const FAIL_OPEN_MS = 30_000;
const POLL_MS = 3_000;
const COMMAND_MAX = 200;
/** A waiter's ticket is eligible while its mtime is this close to the reader's clock; a waiter refreshes it on every poll. */
const TICKET_FRESH_MS = 15_000;
/** The longest a detached holder may be set to live: the largest Bash call timeout (10 min) plus hook mode's 60 s grace. */
export const DETACHED_TTL_MAX_MS = 660_000;
/** A gated ticket is admitted only while CPU busy is under this, nothing is suspended and the last gated start was this long ago (heavy-queue's gates). */
const GATE_CPU_BUSY = 0.75;
const GATE_SPACING_MS = 20_000;
/** A suspendable holder's front end suspends it only while CPU busy is at or above this or the free memory percentage is at or under the second (heavy-queue's thresholds), or at step 0. */
const SUSPEND_CPU_BUSY = 0.95;
const SUSPEND_FREE_PCT = 12;
/** A holder is suspended only after running this long, and at most one is suspended per `SUSPEND_SPACING_MS`, machine-wide. */
export const SUSPEND_MIN_RUN_MS = 20_000;
const SUSPEND_SPACING_MS = 15_000;
/** A suspended holder is resumed only while CPU busy is under this and, in count mode, the free memory percentage is above the second (heavy-queue's thresholds). */
const RESUME_CPU_BUSY = 0.85;
const RESUME_FREE_PCT = 20;
/** The `remindAt` of a record the lease writes; the watchdog reports a lease suspension this old. */
const SUSPEND_REMIND_MS = 30 * 60_000;
/** A stored CPU reading younger than this is gated on as it is; one up to `CPU_DELTA_MAX_MS` old is the base of a new delta; an older one is replaced and fails the poll. */
const CPU_REUSE_MS = 2_000;
const CPU_DELTA_MAX_MS = 10_000;
/** A detached holder's id, and the only ids `releaseHolder` accepts, so neither can name a path outside `holders/` or overrun a file name. */
const HOLDER_ID = /^[\w-]{1,160}$/;

type ReapReason = "stale-heartbeat" | "orphan-bound" | "corrupt" | "dead-session" | "expired";

export type LeaseEvent = (
  | { type: "acquire"; id: string; waitedMs: number; level: PressureLevel; step: number; live: number; capacity: number; override?: true; weights?: Weights & { weight: number } }
  | { type: "release"; id: string; heldMs: number; exitCode?: number }
  | { type: "reap"; id: string; reason: ReapReason }
  /** `level` is the confirmed level of a `stopped` refusal. */
  | { type: "timeout"; refused: "max-wait" | "stopped" | "disk-full"; waitedMs: number; level?: PressureLevel }
  /** `code` and `message` describe the I/O error; a busy mutex has neither. */
  | { type: "fail-open"; reason: "mutex-busy" | "io-error"; waitedMs: number; code?: string; message?: string }
  /** A SIGSTOP or SIGCONT the lease sent to a holder's group; `reason` is the trigger, or `dead-owner` for the continue of a group whose front end is gone. */
  | { type: "suspend" | "resume"; id: string; pgid: number; reason: string }
) & {
  /** The holder class the event is about; absent in a record an older writer wrote, which means `heavy`. */
  class?: "heavy" | "sessions";
};

/** Cumulative CPU tick counters over all cores. */
export interface CpuTicks {
  idle: number;
  total: number;
}

/** `LeaseOptions.cpuTimes` in production: the `os.cpus()` counters, so no process is spawned. */
export function osCpuTicks(): CpuTicks {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += Object.values(times).reduce((a, b) => a + b, 0);
  }
  return { idle, total };
}

export interface LeaseOptions {
  dir: string;
  level: PressureSampler;
  /**
   * The machine-wide headroom step. When set, heavy capacity is `headroomCapacity(step, policy)` and `level` is only a
   * view of it (`defaultLeaseOptions` builds both from one sampler); when absent, capacity comes from `level` alone
   * (`warning` → `policy.heavyWarning`), a path for tests and callers that inject `level`; production callers always have it.
   */
  headroom?: HeadroomSampler;
  policy: PressurePolicy;
  /** The machine-wide ceiling of implementer sessions (`CO_LEASE_SESSION_SLOTS`, default 6); steps below 4 are capped by it. */
  sessionSlots?: number;
  /** The percentage of the machine's memory the heavy class leaves unbudgeted (`CO_LEASE_RESERVE_PCT`, default 25). */
  reservePct?: number;
  isAlive?(pid: number): boolean;
  /**
   * Wall-clock epoch milliseconds (default `Date.now`). It dates heartbeats, which are compared with mtimes the kernel
   * sets on writes, so any other clock (monotonic, scripted, offset) makes live holders read as stale and reaped.
   */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
  /** Reads the CPU tick counters for the gated tickets' CPU gate; absent, or a throw or empty read, means the CPU is unknown and passes. */
  cpuTimes?(): CpuTicks;
  /** The `CO_LEASE_HOLDER` id this process inherited; a live one admits a nested acquire at once. */
  inheritedHolderId?: string;
  /** The command line of a process group's leader (`ps -o command=` by default); throws when it cannot be read. `attempt()` compares it with a suspension record's `leader` before continuing a dead owner's group; absent, none is continued. */
  processCommand?(pgid: number): string;
  /** A throw is warned about once per callback and never changes what the lease does. */
  onEvent?(e: LeaseEvent): void;
  warn?(msg: string): void;
}

/**
 * What a holder file records about the request; `label` replaces `command` when given. `detached` records a holder
 * for a process that is not this one (hook mode): `id` is used as the holder id and must match `[A-Za-z0-9_-]{1,160}`,
 * `sessionPid` is the liveness PID and must be a positive integer, and `expiresAt` must be finite (acquiring throws a
 * `TypeError` otherwise); no heartbeat runs. `expiresAt` is read when the holder is written, so it may be a getter that
 * counts from admission. Acquiring an `id` whose holder is already live admits at once without a second holder or count:
 * two hook installs handling one call share one slot, and the borrowed handle's `release` does nothing.
 */
export interface HolderMeta {
  command: string;
  label?: string;
  cwd: string;
  detached?: { id: string; sessionPid: number; expiresAt: number };
  /** Admit only while heavy-queue's gates pass (CPU under 0.75, nothing suspended, 20 s since the last gated start), or when nothing is live. Set only by the heavy-queue front end. */
  gated?: boolean;
  /** Marks a holder whose front end owns its process group and may suspend it under overload. Set only by the heavy-queue front end. */
  suspendable?: boolean;
  /** Heavy class only: the bytes of memory the command is expected to use. Absent, or not a positive number, takes the unmatched weight (`usable / heavyCeiling`). Ignored while the machine's memory is unknown. */
  weight?: number;
}

interface HolderRecord {
  id: string;
  pid: number;
  childPid?: number;
  /** The command's own process group, when its front end started it in one (for the watchdog and the suspender). */
  pgid?: number;
  /** The front end may suspend this holder's group. */
  suspendable?: true;
  command: string;
  cwd: string;
  startedAt: number;
  /** Detached holders only: epoch ms after which the holder is expired. */
  expiresAt?: number;
  level: PressureLevel;
  override?: true;
  /** Set while the holder's group is stopped; a gated ticket is not admitted while any live holder has it. */
  suspended?: true;
  /** Bytes; absent means the unmatched weight. */
  weight?: number;
}

/** A live holder as `leaseStatus` reports it. */
export interface HolderInfo extends HolderRecord {
  ageSec: number;
}

/** Bytes the live holders weigh and the bytes the budget allows (free memory less the reserve plus the settled holders' weight with a free reading, the step's share of the usable bytes without one); reported only while holders are weighed. */
export interface Weights {
  used: number;
  budget: number;
  /** The free-memory inputs of `budget` (`FreeBudget`), present only when a free reading was used. */
  free?: FreeBudget;
}

export interface LeaseStatus {
  level: PressureLevel;
  capacity: number;
  /** The headroom step, 0 to 4; derived from `level` when no `headroom` sampler is set. */
  step: number;
  /** The kernel signals behind the step; `null` after a failed guarded read, and when no `headroom` sampler is set. */
  signals: MemorySignals | null;
  live: HolderInfo[];
  /** Set only in weight mode (class with a `budget`, machine memory known); count mode leaves it out. */
  weights?: Weights;
  /** Set by `leaseStatus` only: the session class's capacity at the same reading, and its live holders. */
  sessions?: { capacity: number; live: HolderInfo[] };
}

/**
 * A holder stays live only while this process's event loop runs its 30 s heartbeat, or while a child PID recorded
 * through `setChildPid` is alive. A caller that blocks the event loop for 90 s (`execSync`, `spawnSync`) without
 * recording a child is reaped while its command still runs, and stays out of the count until it releases.
 */
export interface LeaseHandle {
  /** `null` for an unleased (fail-open) handle. */
  id: string | null;
  leased: boolean;
  /** `live` counts this holder. `weights` is set in weight mode: this holder's bytes, with `used` counting it. */
  admission: { waitedMs: number; level: PressureLevel; live: number; capacity: number; override?: true; weights?: Weights & { weight: number } };
  /** Env for the child command; the holder id is never put in `process.env`. */
  childEnv(): Record<string, string>;
  /**
   * Records the heavy command's PID right after an async spawn, so the holder stays live while that process runs,
   * even when this one is blocked or killed (up to the 2 h orphan bound). Ignored after release, for a value that is
   * not a positive integer, and once the holder has been reaped: a reaped holder's file is not recreated.
   */
  setChildPid(pid: number, pgid?: number): void;
  /** Sets or clears the holder's `suspended` mark; throws when the mark cannot be written or the holder is gone. Present on a holder this process owns. */
  setSuspended?(on: boolean): void;
  release(outcome?: { exitCode?: number }): void;
}

export interface LeaseRefusal {
  refused: "max-wait" | "stopped" | "disk-full";
  waitedMs: number;
  level: PressureLevel;
  live: number;
  /** The out-of-space error code of a `disk-full` refusal. */
  code?: string;
}

/** What one reading of the machine step means for a holder class: the reading plus the capacity it allows that class. */
type Snapshot = HeadroomReading & { capacity: number };

type Attempt =
  | { kind: "admitted"; handle: LeaseHandle; borrowed?: true }
  | ({ kind: "full" | "busy" } & Snapshot)
  | ({ kind: "error"; error: unknown } & Snapshot);

/**
 * A holder class: where its holders and FIFO tickets live under the lease directory, its capacity at a step given its
 * `ceiling`, and whether liveness is the heartbeat alone (`heartbeatOnly`) or also a detached holder's `expiresAt` and
 * a recorded child PID. A class with a `budget` (bytes at a step, given the usable bytes and, when known, the free-memory reading) admits by summed weight when
 * the machine's memory is known; one without counts holders. Everything that scans, queues and admits takes one, so the classes share one implementation.
 */
interface LeaseClass {
  /** Tags every event the class emits. */
  name: "heavy" | "sessions";
  holders: string;
  waiting: string;
  ceiling(opts: LeaseOptions): number;
  capacity(step: number, ceiling: number): number;
  budget?(step: number, usable: number, free?: FreeBudget): number;
  heartbeatOnly: boolean;
}

const HEAVY: LeaseClass = {
  name: "heavy",
  holders: "holders",
  waiting: "waiting",
  ceiling: (opts) => opts.policy.heavyCeiling,
  capacity: headroomCapacity,
  budget: heavyBudget,
  heartbeatOnly: false,
};

/** Engine implementer sessions: a stopped engine's `claude` children still answer `kill(pid, 0)`, so only the engine's heartbeat keeps a slot. */
const SESSIONS: LeaseClass = {
  name: "sessions",
  holders: "sessions",
  waiting: "sessions-waiting",
  ceiling: (opts) => opts.sessionSlots ?? DEFAULT_SESSION_SLOTS,
  capacity: sessionHeadroomCapacity,
  heartbeatOnly: true,
};

/** The machine step and its capacity for `cls`; with no `headroom` sampler, a step derived from the level (critical 0, warning `heavyWarning`, else 4). `fresh` bypasses every cache. */
function snapshot(opts: LeaseOptions, cls: LeaseClass, fresh = false): Snapshot {
  const ceiling = cls.ceiling(opts);
  if (opts.headroom) {
    const reading = fresh ? opts.headroom.fresh() : opts.headroom();
    return { ...reading, capacity: cls.capacity(reading.step, ceiling) };
  }
  const level = fresh ? opts.level.fresh() : opts.level();
  const step = level === "critical" ? 0 : level === "warning" ? Math.min(MAX_STEP, opts.policy.heavyWarning) : MAX_STEP;
  return { level, step, signals: null, capacity: cls.capacity(step, ceiling) };
}

/**
 * The single liveness rule. A detached holder (`expiresAt` set) is judged first and never by its heartbeat: it is
 * `expired` once `nowMs >= expiresAt` (so a forward clock step frees the slot early), or when `expiresAt` is more
 * than 660 s plus the 90 s heartbeat window ahead (so a backward step of up to 90 s never reaps a holder written
 * within the 660 s cap, and a larger one frees it early), else live while its
 * session PID (`pid`) is alive, and `dead-session` when not. Any other holder is live while its heartbeat is
 * fresh: `mtimeMs` within 90 s of `nowMs`, in either direction (the mutex's rule, so a small backward clock
 * step cannot reap a live holder, while a heartbeat dated further ahead is stale). Otherwise it is live only
 * while its child PID is alive and within the 2 h orphan bound, and else reaped as `stale-heartbeat`. The
 * wrapper PID is never consulted, so a recycled one cannot pin a slot. `null` is a file that is not a holder record.
 * A `heartbeatOnly` class (sessions) skips both the `expiresAt` branch and the child-PID fallback.
 */
function verdict(rec: HolderRecord | null, mtimeMs: number, nowMs: number, alive: (pid: number) => boolean, heartbeatOnly: boolean): "live" | ReapReason {
  if (!rec) return "corrupt";
  if (heartbeatOnly) return isWithinWindow(mtimeMs, nowMs, HEARTBEAT_STALE_MS) ? "live" : "stale-heartbeat";
  if (rec.expiresAt !== undefined) {
    if (nowMs >= rec.expiresAt || rec.expiresAt - nowMs > DETACHED_TTL_MAX_MS + HEARTBEAT_STALE_MS) return "expired";
    return alive(rec.pid) ? "live" : "dead-session";
  }
  if (isWithinWindow(mtimeMs, nowMs, HEARTBEAT_STALE_MS)) return "live";
  if (rec.childPid && alive(rec.childPid)) return Math.abs(nowMs - rec.startedAt) > ORPHAN_MAX_MS ? "orphan-bound" : "live";
  return "stale-heartbeat";
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

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

function parseHolder(text: string): HolderRecord | null {
  try {
    const rec = JSON.parse(text);
    return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" && (rec.expiresAt === undefined || Number.isFinite(rec.expiresAt)) ? { ...rec, weight: positive(rec.weight) } : null;
  } catch {
    return null;
  }
}

/**
 * Throws on an I/O error; a file released since the `readdir` is skipped, and only an unparseable or malformed one is corrupt.
 * Each entry is read through `readOwnFile`, so one that is not a regular file this user owns (a symlink, FIFO, directory or
 * another user's file) is skipped, never followed, waited on or reaped.
 */
function scanHolders(opts: LeaseOptions, cls: LeaseClass): { live: HolderInfo[]; dead: { id: string; reason: ReapReason }[] } {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = join(opts.dir, cls.holders);
  const found = { live: [] as HolderInfo[], dead: [] as { id: string; reason: ReapReason }[] };
  const names = unlessGone(() => readdirSync(dir)) ?? [];
  const nowMs = now();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const entry = unlessGone(() => readOwnFile(join(dir, name)));
    if (entry === undefined) continue;
    const rec = parseHolder(entry.text);
    const v = verdict(rec, entry.mtimeMs, nowMs, isAlive, cls.heartbeatOnly);
    if (v === "live") found.live.push({ ...rec!, ageSec: Math.round((nowMs - rec!.startedAt) / 1000) });
    else found.dead.push({ id: name.slice(0, -".json".length), reason: v });
  }
  return found;
}

/**
 * A waiter's place in line. `capacity` is what its owner last computed and `ready` whether its gates passed then;
 * `ceiling` and `override` are the inputs of that capacity (the owner's class ceiling, and whether its step was the per-process
 * override's), so a reader re-evaluates it at the current machine step instead of trusting a number that went stale when the step rose.
 * A ticket whose owner could not be admitted does not hold up the line. A ticket from a build that predates `capacity` and
 * `ready` counts, and one that predates `ceiling` is read by its recorded `capacity`.
 */
interface Ticket {
  seq: number;
  id: string;
  pid: number;
  label: string;
  gated: boolean;
  capacity?: number;
  ready?: boolean;
  ceiling?: number;
  override?: boolean;
  /** Bytes, recorded only while the machine's memory is known; absent means the unmatched weight. */
  weight?: number;
}

function parseTicket(text: string): Ticket | null {
  try {
    const t = JSON.parse(text);
    if (!(Number.isFinite(t?.seq) && typeof t.id === "string" && isPid(t.pid))) return null;
    // A field of the wrong type reads as absent, so such a ticket counts instead of comparing as a string.
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { ...t, capacity: num(t.capacity), ceiling: num(t.ceiling), ready: typeof t.ready === "boolean" ? t.ready : undefined, override: t.override === true, weight: positive(t.weight) };
  } catch {
    return null;
  }
}

/**
 * Under the mutex: removes the tickets of dead processes and unparseable files, and returns the rest. A ticket is
 * `eligible` while its mtime is within 15 s of the clock; a stale one (its waiter was stopped) is passed over, not reaped,
 * and keeps its `seq` for when the waiter resumes. An entry that is not a regular file this user owns is skipped, as in `scanHolders`.
 */
function scanTickets(opts: LeaseOptions, cls: LeaseClass): (Ticket & { eligible: boolean })[] {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = join(opts.dir, cls.waiting);
  const nowMs = now();
  const found: (Ticket & { eligible: boolean })[] = [];
  for (const name of (unlessGone(() => readdirSync(dir)) ?? []).filter((n) => n.endsWith(".json"))) {
    const entry = unlessGone(() => readOwnFile(join(dir, name)));
    if (entry === undefined) continue;
    const t = parseTicket(entry.text);
    if (!t || !isAlive(t.pid)) rmSync(join(dir, name), { force: true });
    else found.push({ ...t, eligible: isWithinWindow(entry.mtimeMs, nowMs, TICKET_FRESH_MS) });
  }
  return found;
}

/** Writes or refreshes a ticket, dating it on the lease clock before the rename so a reader never sees it with another mtime. */
function writeTicket(opts: LeaseOptions, cls: LeaseClass, t: Ticket): void {
  const file = join(opts.dir, cls.waiting, `${t.id}.json`);
  writeFileAtomic(file, JSON.stringify(t), { mtimeMs: (opts.now ?? Date.now)() });
}

interface CpuReading {
  at: number;
  ticks: CpuTicks;
  busy: number | null;
}

function parseCpuReading(text: string): CpuReading | null {
  try {
    const r = JSON.parse(text);
    return Number.isFinite(r?.at) && Number.isFinite(r.ticks?.idle) && Number.isFinite(r.ticks.total) && (r.busy === null || Number.isFinite(r.busy)) ? r : null;
  } catch {
    return null;
  }
}

/**
 * The CPU busy share, under the mutex: 1 minus the idle share of the ticks since the reading in `cpu.json`. A reading
 * under 2 s old is returned as stored, one 2 to 10 s old is the base of a new delta (and is replaced), and an older,
 * future-dated or missing one is replaced and yields `null`, so the next poll has a delta. Unknown CPU reads as 0 (idle).
 */
export function cpuBusy(opts: LeaseOptions, nowMs: number): number | null {
  let ticks: CpuTicks | undefined;
  try {
    ticks = opts.cpuTimes?.();
  } catch {
    return 0;
  }
  if (!ticks || !(ticks.total > 0)) return 0;
  const file = join(opts.dir, "cpu.json");
  const record = readLeaseRecord(opts.dir, "cpu.json");
  const prev = record && parseCpuReading(record.text);
  const age = prev ? nowMs - prev.at : -1;
  if (prev && age >= 0 && age < CPU_REUSE_MS) return prev.busy;
  const span = prev ? ticks.total - prev.ticks.total : 0;
  const busy = prev && age >= 0 && age <= CPU_DELTA_MAX_MS && span > 0 ? 1 - (ticks.idle - prev.ticks.idle) / span : null;
  writeFileAtomic(file, JSON.stringify({ at: nowMs, ticks, busy }));
  return busy;
}

/** Whether `ms` has passed since the mark `name` in the lease directory; a missing mark, or one from the future, reads as elapsed. */
export function markElapsed(dir: string, name: string, nowMs: number, ms: number): boolean {
  const markedAt = unlessGone(() => statSync(join(dir, name)).mtimeMs);
  return markedAt === undefined || markedAt > nowMs || nowMs - markedAt >= ms;
}

/** Stamps the mark `name` in the lease directory with `nowMs`. */
export function writeMark(dir: string, name: string, nowMs: number): void {
  writeFileAtomic(join(dir, name), "", { mtimeMs: nowMs });
}

/** The gates of a gated ticket. `cpuBusy` always runs, since each poll keeps `cpu.json`'s delta fresh; a `lastAdmit` mark from the future reads as elapsed. */
function gatesPass(opts: LeaseOptions, live: HolderInfo[], nowMs: number): boolean {
  const busy = cpuBusy(opts, nowMs);
  const spaced = markElapsed(opts.dir, "lastAdmit", nowMs, GATE_SPACING_MS);
  return busy !== null && busy < GATE_CPU_BUSY && spaced && !live.some((h) => h.suspended);
}

const byAge = (a: HolderInfo, b: HolderInfo): number => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1);

/** Writes the lease's record for `pgid`; false when the owner's record is there. A leftover with `by: "lease"` on a group that is running is replaced (the record is written before the signal, so a front end that died between the two leaves one). */
function recordSuspension(dir: string, record: SuspensionRecord): boolean {
  try {
    writeSuspension(dir, record);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (!removeLeaseSuspension(dir, record.pgid)) return false;
    writeSuspension(dir, record);
  }
  return true;
}

/**
 * One tick of a suspendable holder's front end: suspends `handle`'s own group, `pgid`, when `handle` is the newest suspendable running holder
 * and the machine is overloaded; true when `stop` ran and sent the signal. The signals are sampled before the mutex; under it the CPU
 * busy share (`cpuBusy`, null never triggers), the 15 s `lastSuspend` mark and the ranking are read, and the record (`by: "lease"`, written through
 * `suspensions.ts`), the holder mark and the mark are written in that order; `stop` (SIGSTOP of `pgid`) runs after the mutex is released.
 * A running group therefore always has a record and a mark by the time it stops. An owner's record on the group means no mark and no signal.
 * A failed write or a `stop` that returns false or throws takes the record and the mark back. Never the oldest running holder, never one
 * under 20 s old, and more holders than the step allows is not a trigger. `leader` is the group leader's command, for the record.
 */
export function suspendNewest(opts: LeaseOptions, handle: LeaseHandle, pgid: number, leader: string | null, stop: (pgid: number) => boolean): boolean {
  if (!handle.setSuspended) return false;
  // The owner's record is read before the mutex, beside the step snapshot: it settles the tick, and the lease never writes over it.
  const held = suspensionOf(opts.dir, pgid);
  if (held && !isLeaseRecord(held)) return false;
  const { step, signals } = snapshot(opts, HEAVY);
  const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
  if (!lock) return false;
  const undo = (): void => {
    try {
      handle.setSuspended!(false);
    } finally {
      removeSuspension(opts.dir, pgid);
    }
  };
  let go = false;
  let why = "";
  try {
    const nowMs = (opts.now ?? Date.now)();
    const busy = cpuBusy(opts, nowMs);
    const free = signals?.freePct;
    why = [
      step === 0 && "step 0",
      busy !== null && busy >= SUSPEND_CPU_BUSY && `CPU ${Math.round(busy * 100)}% busy`,
      free !== undefined && free <= SUSPEND_FREE_PCT && `${free}% memory free`,
    ].filter(Boolean).join(", ");
    if (why && markElapsed(opts.dir, "lastSuspend", nowMs, SUSPEND_SPACING_MS)) {
      // A group with any record is stopped, whoever stopped it, except this one's own (a leftover lease record is replaced).
      const stopped = new Set(readSuspensions(opts.dir).map((r) => r.pgid));
      const running = scanHolders(opts, HEAVY).live.filter((h) => !h.suspended && (h.id === handle.id || h.pgid === undefined || !stopped.has(h.pgid))).sort(byAge);
      const newest = running.slice(1).filter((h) => h.suspendable).at(-1);
      if (newest?.id === handle.id && nowMs - newest.startedAt >= SUSPEND_MIN_RUN_MS) {
        const at = new Date(nowMs).toISOString();
        go = recordSuspension(opts.dir, { pgid, by: "lease", reason: why, at, remindAt: new Date(nowMs + SUSPEND_REMIND_MS).toISOString(), leader });
        if (go) {
          try {
            handle.setSuspended(true);
            writeMark(opts.dir, "lastSuspend", nowMs);
          } catch (err) {
            undo();
            throw err;
          }
        }
      }
    }
  } finally {
    lock.release();
  }
  if (!go) return false;
  let stopped = false;
  try {
    stopped = stop(pgid);
  } finally {
    if (!stopped) undo();
  }
  if (stopped) emit(opts, HEAVY, { type: "suspend", id: handle.id!, pgid, reason: why });
  return stopped;
}

/**
 * One tick of a suspended holder's front end: continues `handle`'s own group, `pgid`, when `handle` is the oldest suspended holder whose front end
 * is alive (a dead owner's group is `attempt()`'s to continue) and the machine
 * has recovered, and returns `"resumed"`. The signals are sampled before the mutex; under it the decision is made and `cont` (SIGCONT of `pgid`) runs
 * after it is released, then the holder's mark is cleared, then the record is removed, so a crash leaves a mark or a record on a running group and never
 * a stopped group without either. Recovered is CPU busy under 0.85 (`cpuBusy`; null means not yet), in count mode a free percentage above 20 (none
 * means not yet; in weight mode the room test below is stricter, since it cannot hold inside the reserve), a step of at least 1, and room: the weights
 * `weigh` gives the running holders plus this one fit its budget, with admission's slack. When no other holder is running, step 0 and room do not
 * apply, but memory still does: in weight mode free memory above the reserve (`weigh`'s `FreeBudget`), or without a free reading a budget above 0.
 * When the group has no record of the lease's (the owner resumed it, or replaced the record with their own) the mark is cleared at once, whatever the
 * load, with no signal and no mutex, and the result is `"cleared"`; the record is checked again right before `cont`, which narrows the window in which
 * an owner's suspend between the decision and the signal is undone. A `cont` that reports the group gone still clears the mark and the record.
 */
export function resumeOldest(opts: LeaseOptions, handle: LeaseHandle, pgid: number, cont: (pgid: number) => boolean): "resumed" | "cleared" | undefined {
  if (!handle.setSuspended) return undefined;
  if (!leaseSuspension(opts.dir, pgid)) {
    handle.setSuspended(false);
    return "cleared";
  }
  const snap = snapshot(opts, HEAVY);
  const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
  if (!lock) return undefined;
  let why = "";
  try {
    const busy = cpuBusy(opts, (opts.now ?? Date.now)());
    const { live } = scanHolders(opts, HEAVY);
    // A suspended holder whose front end is gone cannot tick; `attempt()` continues it, so it does not hold the line here.
    const [oldest] = live.filter((h) => h.suspended && (opts.isAlive ?? pidAlive)(h.pid)).sort(byAge);
    if (oldest?.id === handle.id && busy !== null && busy < RESUME_CPU_BUSY) {
      const running = live.filter((h) => !h.suspended);
      // Weighed over the holders summed below only: another suspended holder's weight would otherwise be added back to the free budget without being charged against it.
      const { usable, budget, of, free } = weigh(opts, HEAVY, snap, [...running, oldest]);
      const alone = running.length === 0;
      const freePct = snap.signals?.freePct;
      const room = alone || running.reduce((sum, h) => sum + of(h), of(oldest)) <= budget * (1 + 1e-12);
      // In weight mode room is the memory test; alone, where room is waived, free memory must still clear the reserve.
      const memory = usable === undefined ? freePct !== undefined && freePct > RESUME_FREE_PCT : !alone || (free ? free.freeBytes > free.reserve : budget > 0);
      if (memory && room && (snap.step > 0 || alone)) why = `CPU ${Math.round(busy * 100)}% busy, step ${snap.step}`;
    }
  } finally {
    lock.release();
  }
  if (!why) return undefined;
  if (!leaseSuspension(opts.dir, pgid)) {
    handle.setSuspended(false);
    return "cleared";
  }
  if (cont(pgid)) emit(opts, HEAVY, { type: "resume", id: handle.id!, pgid, reason: why });
  handle.setSuspended(false);
  try {
    removeLeaseSuspension(opts.dir, pgid);
  } catch (err) {
    warn(opts, `lease: could not remove the suspension record for group ${pgid}: ${(err as Error).message}`);
  }
  return "resumed";
}

/** Under the mutex only: sets or clears the `suspended` mark in the holder file of `id`, keeping its heartbeat mtime; a holder that is gone, or already so, is left alone. */
function markHolder(opts: LeaseOptions, id: string, on: boolean): void {
  const file = join(opts.dir, HEAVY.holders, `${id}.json`);
  const entry = unlessGone(() => readOwnFile(file));
  const rec = entry && parseHolder(entry.text);
  if (!entry || !rec || (rec.suspended === true) === on) return;
  if (on) rec.suspended = true;
  else delete rec.suspended;
  writeFileAtomic(file, JSON.stringify(rec), { mtimeMs: entry.mtimeMs });
}

/**
 * After the mutex: continues the group of a suspended holder whose front end is gone. `attempt()` chose it and cleared its mark under the
 * mutex, so no other acquire picks it too. No resume gate applies, since only the owner's own tick could pass one. The group is signalled only
 * when the record's `leader` is the command `processCommand` now reads for the group: a null leader, a missing or an owner's record, or a
 * changed command means no signal, and the record stays for the watchdog. A lookup that throws also means no signal, and the mark is put back
 * under the mutex (when it is free) so a later acquire tries again; at most one lookup runs per `attempt()`. Never throws.
 */
function continueDeadOwner(opts: LeaseOptions, holder: HolderInfo): void {
  const pgid = holder.pgid!;
  let leader: string | null | undefined;
  let current: string | undefined;
  try {
    leader = leaseSuspension(opts.dir, pgid)?.leader;
    current = typeof leader === "string" ? opts.processCommand?.(pgid) : undefined;
  } catch (err) {
    warn(opts, `lease: could not read the leader of group ${pgid}: ${describeBoundedFailure(err, PROCESS_COMMAND_TIMEOUT_MS)}`);
    const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
    try {
      if (!lock) throw new Error("the lease mutex is busy");
      markHolder(opts, holder.id, true);
    } catch (e) {
      warn(opts, `lease: could not mark group ${pgid} for another try: ${(e as Error).message}`);
    } finally {
      lock?.release();
    }
    return;
  }
  if (current === undefined || current !== leader) return;
  try {
    if (signalGroup(pgid, "SIGCONT")) emit(opts, HEAVY, { type: "resume", id: holder.id, pgid, reason: "dead-owner" });
    removeLeaseSuspension(opts.dir, pgid);
  } catch (err) {
    warn(opts, `lease: could not continue group ${pgid}: ${(err as Error).message}`);
  }
}

const removeTicket = (opts: LeaseOptions, cls: LeaseClass, id: string): void => rmSync(join(opts.dir, cls.waiting, `${id}.json`), { force: true });

// Paste-safety for `status` output and the event log, not a security boundary: the lease does no shell parsing. Nothing
// after the first `=` or `://` is recorded, whatever the quoting, so `NAME=value` credentials and `user:token@` URLs are
// cut off. Secrets with neither marker before them (`-p pass`, `Authorization:` headers) are not; such callers pass a label.
const CUT = /=|:\/\//;

/** The caller's label verbatim, else the command up to its first `=` or `://` plus `…`; then truncated. */
function recordedCommand({ command, label }: HolderMeta): string {
  if (label !== undefined) return label.slice(0, COMMAND_MAX);
  const cut = CUT.exec(command);
  return (cut ? `${command.slice(0, cut.index + cut[0].length)}…` : command).slice(0, COMMAND_MAX);
}

function createHolder(opts: LeaseOptions, cls: LeaseClass, meta: HolderMeta, command: string, admission: LeaseHandle["admission"]): LeaseHandle {
  const now = opts.now ?? Date.now;
  const { detached } = meta;
  const id = detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  const file = join(opts.dir, cls.holders, `${id}.json`);
  const rec: HolderRecord = { id, pid: detached?.sessionPid ?? process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
  if (detached) rec.expiresAt = detached.expiresAt;
  if (admission.override) rec.override = true;
  if (meta.suspendable) rec.suspendable = true;
  if (positive(meta.weight) !== undefined) rec.weight = meta.weight;
  const write = (): void => writeFileAtomic(file, JSON.stringify(rec));
  write();
  let released = false;
  // A detached holder gets no heartbeat: its session PID and `expiresAt` keep it live.
  // Unref'd, so it never keeps the process alive. A file found gone was reaped: its heartbeat went stale (this event
  // loop stalled past 90 s, or the wall clock jumped) with no live child recorded. Such a holder stays out of the count
  // for the rest of its run, so neither the beat (utimes never creates) nor setChildPid recreates the file.
  const beat = detached ? undefined : setInterval(() => {
    try {
      const at = now() / 1000;
      utimesSync(file, at, at);
    } catch {
      // Reaped, which is final, or unwritable for now, which the next beat retries.
    }
  }, HEARTBEAT_MS);
  beat?.unref();
  return {
    id,
    leased: true,
    admission,
    childEnv: () => ({ CO_LEASE_HOLDER: id }),
    setChildPid(pid, pgid) {
      if (released || !isPid(pid)) return;
      rec.childPid = pid;
      if (pgid !== undefined && isPid(pgid)) rec.pgid = pgid;
      try {
        // Only a file still there is replaced; a reap between this check and the rename is not detected.
        if (unlessGone(() => statSync(file))) write();
      } catch {
        // The previous record still names this holder.
      }
    },
    setSuspended(on) {
      if (released || !unlessGone(() => statSync(file))) throw new Error(`holder ${id} is gone`);
      if (on) rec.suspended = true;
      else delete rec.suspended;
      write();
    },
    release(outcome) {
      if (released) return;
      released = true;
      clearInterval(beat);
      try {
        unlinkSync(file);
      } catch {
        // Already reaped.
      }
      emit(opts, cls, { type: "release", id, heldMs: now() - rec.startedAt, ...(outcome?.exitCode !== undefined && { exitCode: outcome.exitCode }) });
    },
  };
}

function borrowedHandle(id: string, level: PressureLevel, capacity: number, live: number): LeaseHandle {
  return { id, leased: true, admission: { waitedMs: 0, level, live, capacity }, childEnv: () => ({ CO_LEASE_HOLDER: id }), setChildPid() {}, release() {} };
}

/**
 * The one weight rule: bytes when the class has a `budget` and the reading carries the machine's memory (a holder without a weight takes
 * the unmatched `usable / ceiling`), else every weight is 1 and the budget is the capacity, which is the count rule. With a free reading too,
 * the budget is free memory less the reserve plus the weight of the `live` holders older than `RAMP_MS` (younger ones have not grown into their
 * memory, so they are charged in full); without one it is the step's share of `usable`. `report` is the used/budget pair for the given
 * holders (with the `FreeBudget` inputs when asked, which `status` does), or `undefined` in count mode.
 */
function weigh(opts: LeaseOptions, cls: LeaseClass, { step, capacity = 0, signals }: Pick<Snapshot, "step" | "signals"> & Partial<Pick<Snapshot, "capacity">>, live: { weight?: number; startedAt: number }[]) {
  const memsize = positive(signals?.memsizeBytes);
  const usable = cls.budget && memsize !== undefined ? usableBytes(memsize, opts.reservePct ?? DEFAULT_RESERVE_PCT) : undefined;
  const unmatched = usable === undefined ? 1 : usable / cls.ceiling(opts);
  const of = (x: { weight?: number }): number => (usable === undefined ? 1 : (x.weight ?? unmatched));
  const freeNow = signals ? freeBytes(signals) : undefined;
  const nowMs = (opts.now ?? Date.now)();
  const free: FreeBudget | undefined =
    freeNow === undefined || usable === undefined ? undefined : { freeBytes: freeNow, reserve: memsize! - usable, settled: live.filter((h) => nowMs - h.startedAt >= RAMP_MS).reduce((sum, h) => sum + of(h), 0) };
  const budget = usable === undefined ? capacity : cls.budget!(step, usable, free);
  const report = (holders: { weight?: number }[], withFree = false): Weights | undefined =>
    usable === undefined ? undefined : { used: holders.reduce((sum, x) => sum + of(x), 0), budget, ...(withFree && free && { free }) };
  return { usable, budget, of, report, free };
}

/**
 * One admission attempt for a holder class: sample the step, then weigh and write holders under the mutex. Weights are bytes when the class
 * has a `budget` and the reading carries the machine's memory (the unmatched weight, `usable / ceiling`, stands in for a missing one),
 * else every weight is 1 and the budget is the capacity, which is the count rule. Admission is FIFO: a waiter (`ticketId` set) is
 * admitted when the live weights, those of the tickets that count as ahead of its own, and its own fit the budget, or when nothing
 * is live or ahead and the step is above 0 (a command heavier than the budget runs alone, and a head-of-line waiter blocks
 * lighter ones behind it), and a refused one writes or refreshes its ticket. Without a `ticketId` (`tryAcquireLease`) it is admitted
 * only when it fits and no ticket counts as ahead, and writes none. Caller code (`warn`, `onEvent`) runs only after the mutex is released,
 * so a slow callback cannot outlive its staleness window.
 */
function attempt(opts: LeaseOptions, cls: LeaseClass, meta: HolderMeta, waitedMs: number, ticketId?: string): Attempt {
  const snap = snapshot(opts, cls);
  const { level, capacity } = snap;
  const overridden = (opts.headroom ?? opts.level).overridden?.() === true;
  const command = recordedCommand(meta);
  const reaped: { id: string; reason: ReapReason }[] = [];
  let orphan: HolderInfo | undefined;
  let r: Attempt;
  try {
    ensureOwnSubdir(opts.dir, cls.holders);
    ensureOwnSubdir(opts.dir, cls.waiting);
    const scan = scanHolders(opts, cls);
    if (opts.inheritedHolderId && scan.live.some((h) => h.id === opts.inheritedHolderId)) {
      return { kind: "admitted", handle: borrowedHandle(opts.inheritedHolderId, level, capacity, scan.live.length) };
    }
    const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
    if (!lock) return { kind: "busy", ...snap };
    try {
      const { live, dead } = scanHolders(opts, cls);
      for (const d of dead) {
        rmSync(join(opts.dir, cls.holders, `${d.id}.json`), { force: true });
        reaped.push(d);
      }
      // A writer killed between its write and rename leaves a uniquely named temp file: remove those of dead writers in this class's directories and the root. Only here, under the mutex; the scanners and `leaseStatus` never delete.
      for (const d of [cls.holders, cls.waiting, ""]) sweepDeadTemps(join(opts.dir, d), opts.isAlive ?? pidAlive);
      // The oldest suspended holder whose front end is gone (ESRCH; a stopped one is alive and is left alone); its group is continued after the mutex.
      if (cls === HEAVY) orphan = live.filter((h) => h.suspended && h.pgid !== undefined && !(opts.isAlive ?? pidAlive)(h.pid)).sort(byAge)[0];
      // Claimed under the mutex, so a concurrent acquire does not pick the same group.
      if (orphan) {
        try {
          markHolder(opts, orphan.id, false);
        } catch {
          orphan = undefined; // Unclaimed: left for a later acquire, and the admission is unchanged.
        }
      }
      const { usable, budget, of: weightOf, report } = weigh(opts, cls, snap, live);
      const myWeight = weightOf({ weight: positive(meta.weight) });
      const weights = report([...live, { weight: myWeight }]);
      const admission = { waitedMs, level, live: live.length + 1, capacity, ...(overridden && { override: true as const }), ...(weights && { weights: { ...weights, weight: myWeight } }) };
      // A second hook install for the same call acquires the id the first one holds: that call is already admitted.
      if (meta.detached && live.some((h) => h.id === meta.detached!.id)) r = { kind: "admitted", handle: borrowedHandle(meta.detached.id, level, capacity, live.length), borrowed: true };
      else {
        const line = scanTickets(opts, cls);
        const mine = line.find((t) => t.id === ticketId);
        const seq = mine?.seq ?? Math.max(0, ...line.map((t) => t.seq)) + 1;
        const nowMs = (opts.now ?? Date.now)();
        const gated = meta.gated === true;
        // A ticket counts as ahead only while its owner could be admitted and its gates passed at its last poll. By count that is a slot by its own
        // capacity; by weight it is any step above 0, since a ticket heavier than the budget runs alone and so is the head of the line, not a bystander.
        // Its capacity is re-evaluated at the machine step now (the raw step is 0 under this reader's override), with the override only when its owner has it.
        const machineStep = overridden ? 0 : snap.step;
        const ticketStep = (t: Ticket): number => (t.override && machineStep === 0 ? 1 : machineStep);
        const ticketCapacity = (t: Ticket): number => (t.ceiling === undefined ? (t.capacity ?? Infinity) : cls.capacity(ticketStep(t), t.ceiling));
        const counts = (t: Ticket): boolean => (usable === undefined ? ticketCapacity(t) > live.length : ticketStep(t) > 0);
        const others = line.filter((t) => t.eligible && t.id !== ticketId && (ticketId === undefined || t.seq < seq) && counts(t));
        const ahead = others.filter((t) => t.ready !== false);
        const taken = [...live, ...ahead].reduce((sum, x) => sum + weightOf(x), 0);
        // A relative slack of 1e-12 absorbs the rounding of `usable / ceiling` sums and is far below a byte.
        const fits = taken + myWeight <= budget * (1 + 1e-12) || (usable !== undefined && live.length + ahead.length === 0 && snap.step > 0);
        // The gates are machine-wide, so a gated waiter waits for every older gated ticket that could be admitted, however many slots are free:
        // FIFO holds among gated tickets, and the next gated start's 20 s spacing goes to the oldest.
        const behindGated = gated && others.some((t) => t.gated);
        // No-wedge: with nothing live, the oldest gated ticket is admitted past its gates, except at step 0 (capacity 0 already refuses there; the clause keeps the rule true if a policy ever gives step 0 a slot).
        const ready = !gated || gatesPass(opts, live, nowMs) || (live.length === 0 && snap.step > 0);
        if (ready && !behindGated && fits && (ticketId !== undefined || ahead.length === 0)) {
          if (gated) writeMark(opts.dir, "lastAdmit", nowMs);
          r = { kind: "admitted", handle: createHolder(opts, cls, meta, command, admission) };
          try {
            if (mine) removeTicket(opts, cls, mine.id);
          } catch {
            // The holder exists, so the admission stands; a ticket that stays is removed when the waiter returns, or reaped once it exits.
          }
        } else {
          if (ticketId !== undefined) writeTicket(opts, cls, { seq, id: ticketId, pid: process.pid, label: command, gated, capacity, ceiling: cls.ceiling(opts), ready: ready && !behindGated, ...(overridden && { override: true }), ...(usable !== undefined && { weight: myWeight }) });
          r = { kind: "full", ...snap };
        }
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    r = { kind: "error", ...snap, error };
  }
  for (const { id, reason } of reaped) {
    if (reason === "orphan-bound") warn(opts, `lease: reaping holder ${id}: its child outlived the 2 h orphan bound`);
    emit(opts, cls, { type: "reap", id, reason });
  }
  if (r.kind === "admitted" && !r.borrowed) emit(opts, cls, { type: "acquire", id: r.handle.id!, ...r.handle.admission, step: snap.step });
  if (orphan) continueDeadOwner(opts, orphan);
  return r;
}

/** The one default diagnostics writer, shared with the event sink. Messages carry their own `lease:` prefix. */
export function defaultWarn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

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
const emit = (opts: LeaseOptions, cls: LeaseClass, e: LeaseEvent): void => guarded(opts, opts.onEvent, { ...e, class: cls.name });

/** An out-of-space error: the lease refuses instead of failing open, since unleased builds are the worst load on a full disk. Nothing is written to report it. */
const diskFullCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? code : undefined;
};

function failOpen(opts: LeaseOptions, cls: LeaseClass, level: PressureLevel, capacity: number, waitedMs: number, reason: "mutex-busy" | "io-error", error?: unknown): LeaseHandle {
  warn(opts, `lease: unavailable (${reason}); running unleased`);
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  emit(opts, cls, { type: "fail-open", reason, waitedMs, ...(code !== undefined && { code }), ...(message !== undefined && { message }) });
  return { id: null, leased: false, admission: { waitedMs, level, live: 0, capacity }, childEnv: () => ({}), setChildPid() {}, release() {} };
}

/** Throws on a detached id, session PID or `expiresAt` that would write a holder the next scan reaps as corrupt: a caller's bug, not an I/O error to fail open on. */
function checkDetached(meta: HolderMeta): void {
  const d = meta.detached;
  if (!d) return;
  if (!HOLDER_ID.test(d.id)) throw new TypeError(`lease: detached holder id ${JSON.stringify(d.id)} is not 1 to 160 of [A-Za-z0-9_-]`);
  if (!isPid(d.sessionPid)) throw new TypeError(`lease: detached session PID ${String(d.sessionPid)} is not a positive integer below 2^31`);
  if (!Number.isFinite(d.expiresAt)) throw new TypeError(`lease: detached expiresAt ${String(d.expiresAt)} is not a finite number`);
}

/** A single non-blocking attempt: a handle, or `null` when not admitted this poll (a full disk included: it is never failed open, and emits a `timeout` event with `refused: "disk-full"`). Throws a `TypeError` on an invalid detached id, session PID or `expiresAt`. */
export function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null {
  checkDetached(meta);
  const r = attempt(opts, HEAVY, meta, 0);
  if (r.kind === "admitted") return r.handle;
  const code = r.kind === "error" ? diskFullCode(r.error) : undefined;
  if (code !== undefined) {
    emit(opts, HEAVY, { type: "timeout", refused: "disk-full", waitedMs: 0 });
    return null;
  }
  return r.kind === "error" && r.level !== "critical" ? failOpen(opts, HEAVY, r.level, r.capacity, 0, "io-error", r.error) : null;
}

/** Live holders of `cls`, or none when the directory cannot be read. */
function liveOf(opts: LeaseOptions, cls: LeaseClass): HolderInfo[] {
  try {
    return scanHolders(opts, cls).live;
  } catch {
    return [];
  }
}

const statusOf = (opts: LeaseOptions, cls: LeaseClass, snap: Snapshot): LeaseStatus => {
  const { level, capacity, step, signals } = snap;
  const live = liveOf(opts, cls);
  const weights = weigh(opts, cls, snap, live).report(live, true);
  return { level, capacity, step, signals, live, ...(weights && { weights }) };
};

/**
 * Polls (3 s ± 1 s, never spinning) until admitted, in the order waiters arrived: each waits behind a ticket in
 * `<dir>/waiting/`, which it removes when it is admitted, when it gives up and when this returns or throws. `stopWhen` is checked on every poll, and a stop is confirmed with a
 * `level.fresh()` re-read before it is returned, so one stale cached sample cannot end a wave. `onWait` runs on each poll
 * that neither admits nor refuses, and also receives `waitedMs`: the wait so far, measured on `LeaseOptions.now` the
 * same way as an admission's or refusal's `waitedMs`, so a progress line can throttle on it without a clock of its own.
 */
export async function acquireLease(opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait = {}): Promise<LeaseHandle | LeaseRefusal> {
  checkDetached(meta);
  return acquire(opts, HEAVY, meta, wait, meta.detached?.id);
}

/** What a session holder records; it is never detached, gated or suspendable. */
export type SessionMeta = Pick<HolderMeta, "command" | "label" | "cwd">;

/**
 * `acquireLease` for one implementer session of an engine, from the machine-wide pool of the session row (`sessions/`,
 * FIFO tickets in `sessions-waiting/`; 6, 4, 2, 1 and 0 sessions at steps 4 to 0, capped by `LeaseOptions.sessionSlots`).
 * The holder lives in the calling process and stays live only while that process's 30 s heartbeat runs: a stopped engine
 * frees its slots after 90 s, whatever its `claude` children are doing. The stop rule is `wait.stopWhen`, as for a heavy
 * acquire, and it sees the session holders and capacity. Interactive sessions take no slot.
 */
export function acquireSessionLease(opts: LeaseOptions, meta: SessionMeta, wait: LeaseWait = {}): Promise<LeaseHandle | LeaseRefusal> {
  // Rebuilt field by field, so a caller's `detached`, `gated` or `weight` can never reach the session class.
  return acquire(opts, SESSIONS, { command: meta.command, cwd: meta.cwd, ...(meta.label !== undefined && { label: meta.label }) }, wait);
}

async function acquire(opts: LeaseOptions, cls: LeaseClass, meta: HolderMeta, wait: LeaseWait, id?: string): Promise<LeaseHandle | LeaseRefusal> {
  const ticketId = id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    return await pollForLease(opts, cls, meta, wait, ticketId);
  } finally {
    try {
      removeTicket(opts, cls, ticketId);
    } catch {
      // A ticket that stays is reaped once this process exits.
    }
  }
}

type LeaseWait = { maxWaitMs?: number; onWait?(s: LeaseStatus & { waitedMs: number }): void; stopWhen?(s: LeaseStatus): boolean };

async function pollForLease(opts: LeaseOptions, cls: LeaseClass, meta: HolderMeta, wait: LeaseWait, ticketId: string): Promise<LeaseHandle | LeaseRefusal> {
  const { now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = POLL_MS } = opts;
  const start = now();
  let busySince: number | undefined;
  for (;;) {
    const waitedMs = now() - start;
    const r = attempt(opts, cls, meta, waitedMs, ticketId);
    if (r.kind === "admitted") return r.handle;
    busySince = r.kind === "busy" ? (busySince ?? now()) : undefined;
    const code = r.kind === "error" ? diskFullCode(r.error) : undefined;
    if (code !== undefined) {
      emit(opts, cls, { type: "timeout", refused: "disk-full", waitedMs });
      return { refused: "disk-full", waitedMs, level: r.level, live: 0, code };
    }
    if (r.level !== "critical") {
      if (r.kind === "error") return failOpen(opts, cls, r.level, r.capacity, waitedMs, "io-error", r.error);
      if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS) return failOpen(opts, cls, r.level, r.capacity, waitedMs, "mutex-busy");
    }
    const status = r.kind === "error" ? { level: r.level, capacity: r.capacity, step: r.step, signals: r.signals, live: [] } : statusOf(opts, cls, r);
    const refuse = (refused: LeaseRefusal["refused"], level: PressureLevel, live: number): LeaseRefusal => {
      emit(opts, cls, { type: "timeout", refused, waitedMs, ...(refused === "stopped" && { level }) });
      return { refused, waitedMs, level, live };
    };
    if (wait.stopWhen?.(status)) {
      const confirmed = snapshot(opts, cls, true);
      if (wait.stopWhen({ ...status, ...confirmed })) return refuse("stopped", confirmed.level, status.live.length);
    }
    if (wait.maxWaitMs !== undefined && waitedMs >= wait.maxWaitMs) return refuse("max-wait", r.level, status.live.length);
    wait.onWait?.({ ...status, waitedMs });
    const jittered = Math.round(pollMs * (2 / 3 + Math.random() * (2 / 3)));
    await sleep(wait.maxWaitMs === undefined ? jittered : Math.min(jittered, wait.maxWaitMs - waitedMs));
  }
}

/**
 * Releases a detached holder by id from any process; idempotent. Returns whether a holder file was removed, and emits
 * one `release` event with `heldMs` only then. It removes only a valid detached record (one with `expiresAt`): a
 * wrapper's own holder and a corrupt file are left to their owner and the reaper. An id that is not 1 to 160 of
 * `[A-Za-z0-9_-]` names no holder, and a holders or lease directory that breaks the directory rule (a symlink, or
 * another user's) is not read, so neither can reach a file outside `holders/`.
 */
export function releaseHolder(opts: LeaseOptions, id: string): boolean {
  if (!HOLDER_ID.test(id)) return false;
  const dir = join(opts.dir, HEAVY.holders);
  const ownDir = (d: string): boolean => {
    const st = unlessGone(() => lstatSync(d));
    return st !== undefined && isOwnDir(st);
  };
  if (!ownDir(opts.dir) || !ownDir(dir)) return false;
  const file = join(dir, `${id}.json`);
  const text = unlessGone(() => readOwnFile(file))?.text;
  const rec = text === undefined ? null : parseHolder(text);
  if (rec?.expiresAt === undefined || unlessGone(() => (unlinkSync(file), true)) === undefined) return false;
  emit(opts, HEAVY, { type: "release", id, heldMs: (opts.now ?? Date.now)() - rec.startedAt });
  return true;
}

/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export function leaseStatus(opts: LeaseOptions): LeaseStatus {
  const snap = snapshot(opts, HEAVY);
  return { ...statusOf(opts, HEAVY, snap), sessions: { capacity: SESSIONS.capacity(snap.step, SESSIONS.ceiling(opts)), live: liveOf(opts, SESSIONS) } };
}

/**
 * Production wiring: the real lease directory, the engine's own sampler and policy, and the `events.jsonl` sink. Creates nothing on disk.
 * `overrides.level` replaces the sampler (none is built, so the lease sizes capacity from that level alone: warning gives `heavyWarning`, 1, not the default step table's 3 or 2; a test-only path, and every production caller passes no `level`), and `overrides.warn` is the one writer for the lease, the sink,
 * the policy and the sampler it builds; without it each keeps its stderr default.
 * The writer is wrapped once so it cannot change what the lease does: a writer that throws is silenced (the line is dropped and nothing reports it), so pass a bound function,
 * and the returned `warn` is that wrapper, not the caller's function.
 */
export function defaultLeaseOptions(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { level?: PressureSampler; warn?: (msg: string) => void } = {},
): LeaseOptions {
  // One non-throwing writer for every consumer; policy and sampler lines get a `memory-pressure:` tag since the writer is not stderr's tagged default.
  const inject = overrides.warn;
  const safe = (msg: string): void => {
    try {
      inject?.(msg);
    } catch {
      // A diagnostics writer must never change what the lease does.
    }
  };
  const warn = inject && safe;
  const tagged = warn && ((msg: string): void => warn(`memory-pressure: ${msg}`));
  const dir = leaseDirectory(env);
  // One sampler is the source of truth: `level` (and `level.fresh`) is a view over it, unless the caller supplies its own level.
  let opts: LeaseOptions;
  const headroom = overrides.level ? undefined : defaultHeadroomSampler(env, {
        log: tagged,
        heavy: (step, signals) => {
          const { live } = scanHolders(opts, HEAVY);
          return { live: live.length, weights: weigh(opts, HEAVY, { step, signals }, live).report(live) };
        },
      });
  const level = overrides.level ?? levelView(headroom!);
  return (opts = {
    dir,
    level,
    ...(headroom && { headroom }),
    policy: pressurePolicyFromEnv(env, tagged),
    sessionSlots: sessionSlotsFromEnv(env, tagged),
    reservePct: reservePctFromEnv(env, tagged),
    inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
    cpuTimes: osCpuTicks,
    processCommand: (pgid) => psField(pgid, "command", { timeoutMs: PROCESS_COMMAND_TIMEOUT_MS }),
    onEvent: leaseEventSink(dir, { warn }),
    warn,
  });
}
