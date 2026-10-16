/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under the heavy capacity of the headroom step (`headroomCapacity(step, policy)`;
 * `heavyCapacity(level, policy)` when only a `level` sampler is given). Liveness is a live
 * heartbeat (the holder file's mtime, refreshed every 30 s) or a live child PID,
 * so a crashed or killed holder cannot leak a slot. A second holder class, `sessions/`, bounds implementer sessions machine-wide
 * with heartbeat-only liveness and its own capacity row (`acquireSessionLease`). A detached holder (hook mode) is live while its session PID is
 * alive and its `expiresAt` has not passed. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { isWithinWindow, tryLockOnce } from "./file-lock.js";
import { headroomCapacity, MAX_STEP } from "./headroom.js";
import { defaultHeadroomSampler, levelView, type HeadroomReading, type HeadroomSampler } from "./headroom-sampler.js";
import { ensureOwnSubdir, isOwnDir } from "./lease-dir.js";
import { leaseEventSink } from "./lease-events.js";
import {
  DEFAULT_SESSION_CEILING,
  heavyCapacity,
  leaseDirectory,
  pressurePolicyFromEnv,
  type MemorySignals,
  type PressureLevel,
  type PressurePolicy,
  type PressureSampler,
} from "./memory-pressure.js";
import { isPid } from "./ps.js";

export { ensureOwnSubdir, isOwnDir, isPid };

const MUTEX_STALE_MS = 10_000;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
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
/** A stored CPU reading younger than this is gated on as it is; one up to `CPU_DELTA_MAX_MS` old is the base of a new delta; an older one is replaced and fails the poll. */
const CPU_REUSE_MS = 2_000;
const CPU_DELTA_MAX_MS = 10_000;
/** A detached holder's id, and the only ids `releaseHolder` accepts, so neither can name a path outside `holders/` or overrun a file name. */
const HOLDER_ID = /^[\w-]{1,160}$/;

type ReapReason = "stale-heartbeat" | "orphan-bound" | "corrupt" | "dead-session" | "expired";

export type LeaseEvent =
  | { type: "acquire"; id: string; waitedMs: number; level: PressureLevel; step: number; live: number; capacity: number; override?: true }
  | { type: "release"; id: string; heldMs: number; exitCode?: number }
  | { type: "reap"; id: string; reason: ReapReason }
  /** `level` is the confirmed level of a `stopped` refusal. */
  | { type: "timeout"; refused: "max-wait" | "stopped"; waitedMs: number; level?: PressureLevel }
  /** `code` and `message` describe the I/O error; a busy mutex has neither. */
  | { type: "fail-open"; reason: "mutex-busy" | "io-error"; waitedMs: number; code?: string; message?: string };

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
}

/** A live holder as `leaseStatus` reports it. */
export interface HolderInfo extends HolderRecord {
  ageSec: number;
}

export interface LeaseStatus {
  level: PressureLevel;
  /** Slots of the class asked about: heavy for `leaseStatus` and `acquireLease`, the session row for `acquireSessionLease`. */
  capacity: number;
  /** The headroom step, 0 to 4; derived from `level` when no `headroom` sampler is set. */
  step: number;
  /** The kernel signals behind the step; `null` after a failed guarded read, and when no `headroom` sampler is set. */
  signals: MemorySignals | null;
  live: HolderInfo[];
  /** The machine-wide implementer-session pool, from the same reading as `capacity`. */
  sessions: { capacity: number; live: HolderInfo[] };
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
  /** `live` counts this holder. */
  admission: { waitedMs: number; level: PressureLevel; live: number; capacity: number; override?: true };
  /** Env for the child command; the holder id is never put in `process.env`. */
  childEnv(): Record<string, string>;
  /**
   * Records the heavy command's PID right after an async spawn, so the holder stays live while that process runs,
   * even when this one is blocked or killed (up to the 2 h orphan bound). Ignored after release, for a value that is
   * not a positive integer, and once the holder has been reaped: a reaped holder's file is not recreated.
   */
  setChildPid(pid: number, pgid?: number): void;
  release(outcome?: { exitCode?: number }): void;
}

export interface LeaseRefusal {
  refused: "max-wait" | "stopped";
  waitedMs: number;
  level: PressureLevel;
  live: number;
}

/** What one reading of the machine step means for this lease: the reading plus the slots it allows each class. */
type Snapshot = HeadroomReading & { capacity: number; sessions: number };

/**
 * A holder class: where its holders and FIFO tickets live, how its liveness is judged and its capacity row. One ticket and
 * holder implementation serves both. `capacity(step, ceiling)` is also what a ticket's recorded ceiling is re-evaluated with.
 */
interface LeaseClass {
  holders: string;
  waiting: string;
  /** No child-PID fallback: a stopped process's children still answer `kill(pid, 0)`. */
  heartbeatOnly: boolean;
  ceiling(policy: PressurePolicy): number;
  capacity(step: number, ceiling: number): number;
  slots(s: Snapshot): number;
}

const HEAVY: LeaseClass = {
  holders: "holders",
  waiting: "waiting",
  heartbeatOnly: false,
  ceiling: (p) => p.heavyCeiling,
  capacity: (step, ceiling) => headroomCapacity(step, { heavyCeiling: ceiling }),
  slots: (s) => s.capacity,
};

/** Implementer sessions by step 0 to 3; step 4 gets the whole ceiling. */
const SESSION_ROW = [0, 1, 2, 4];
const SESSIONS: LeaseClass = {
  holders: "sessions",
  waiting: "sessions-waiting",
  heartbeatOnly: true,
  ceiling: (p) => p.sessionCeiling ?? DEFAULT_SESSION_CEILING,
  capacity: (step, ceiling) => (step >= MAX_STEP ? ceiling : Math.min(ceiling, SESSION_ROW[step] ?? 0)),
  slots: (s) => s.sessions,
};

type Attempt =
  | { kind: "admitted"; handle: LeaseHandle; borrowed?: true }
  | ({ kind: "full" | "busy" } & Snapshot)
  | ({ kind: "error"; error: unknown } & Snapshot);

/** The machine step and each class's capacity; with no `headroom` sampler, today's level-only rule for heavy, and a step derived from the level. `fresh` bypasses every cache. */
function snapshot(opts: LeaseOptions, fresh = false): Snapshot {
  const { policy } = opts;
  const at = (reading: HeadroomReading, capacity = HEAVY.capacity(reading.step, policy.heavyCeiling)): Snapshot => ({ ...reading, capacity, sessions: SESSIONS.capacity(reading.step, SESSIONS.ceiling(policy)) });
  if (opts.headroom) return at(fresh ? opts.headroom.fresh() : opts.headroom());
  const level = fresh ? opts.level.fresh() : opts.level();
  const step = level === "critical" ? 0 : level === "warning" ? Math.min(MAX_STEP, policy.heavyWarning) : MAX_STEP;
  return at({ level, step, signals: null }, heavyCapacity(level, policy));
}

const holdersDir = (dir: string, cls: LeaseClass): string => join(dir, cls.holders);
const waitingDir = (dir: string, cls: LeaseClass): string => join(dir, cls.waiting);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The single liveness rule. A detached holder (`expiresAt` set) is judged first and never by its heartbeat: it is
 * `expired` once `nowMs >= expiresAt` (so a forward clock step frees the slot early), or when `expiresAt` is more
 * than 660 s plus the 90 s heartbeat window ahead (so a backward step of up to 90 s never reaps a holder written
 * within the 660 s cap, and a larger one frees it early), else live while its
 * session PID (`pid`) is alive, and `dead-session` when not. Any other holder is live while its heartbeat is
 * fresh: `mtimeMs` within 90 s of `nowMs`, in either direction (the mutex's rule, so a small backward clock
 * step cannot reap a live holder, while a heartbeat dated further ahead is stale). Otherwise it is live only
 * while its child PID is alive and within the 2 h orphan bound (never for a `heartbeatOnly` class), and else reaped as `stale-heartbeat`. The
 * wrapper PID is never consulted, so a recycled one cannot pin a slot. `null` is a file that is not a holder record.
 */
function verdict(rec: HolderRecord | null, mtimeMs: number, nowMs: number, alive: (pid: number) => boolean, heartbeatOnly: boolean): "live" | ReapReason {
  if (!rec) return "corrupt";
  if (rec.expiresAt !== undefined) {
    if (nowMs >= rec.expiresAt || rec.expiresAt - nowMs > DETACHED_TTL_MAX_MS + HEARTBEAT_STALE_MS) return "expired";
    return alive(rec.pid) ? "live" : "dead-session";
  }
  if (isWithinWindow(mtimeMs, nowMs, HEARTBEAT_STALE_MS)) return "live";
  if (!heartbeatOnly && rec.childPid && alive(rec.childPid)) return Math.abs(nowMs - rec.startedAt) > ORPHAN_MAX_MS ? "orphan-bound" : "live";
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

function parseHolder(text: string): HolderRecord | null {
  try {
    const rec = JSON.parse(text);
    return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" && (rec.expiresAt === undefined || Number.isFinite(rec.expiresAt)) ? rec : null;
  } catch {
    return null;
  }
}

/** Throws on an I/O error; a file released since the `readdir` is skipped, and only an unparseable or malformed one is corrupt. */
function scanHolders(opts: LeaseOptions, cls: LeaseClass): { live: HolderInfo[]; dead: { id: string; reason: ReapReason }[] } {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = holdersDir(opts.dir, cls);
  const found = { live: [] as HolderInfo[], dead: [] as { id: string; reason: ReapReason }[] };
  const names = unlessGone(() => readdirSync(dir)) ?? [];
  const nowMs = now();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const text = unlessGone(() => readFileSync(join(dir, name), "utf8"));
    if (text === undefined) continue;
    const rec = parseHolder(text);
    const mtimeMs = unlessGone(() => statSync(join(dir, name)).mtimeMs);
    if (mtimeMs === undefined) continue;
    const v = verdict(rec, mtimeMs, nowMs, isAlive, cls.heartbeatOnly);
    if (v === "live") found.live.push({ ...rec!, ageSec: Math.round((nowMs - rec!.startedAt) / 1000) });
    else found.dead.push({ id: name.slice(0, -".json".length), reason: v });
  }
  return found;
}

/**
 * A waiter's place in line. `ceiling` and `override` are the inputs its owner's capacity came from (`step` is the step it
 * was served, for diagnosis): a reader re-evaluates them at the current step, so a rise since the owner's last poll cannot
 * let a younger waiter pass it. `capacity` is that owner's last result, used only by a ticket without `ceiling`, and `ready`
 * whether its gates passed then; a ticket whose owner could not be admitted does not hold up the line. Builds that predate
 * a field write none of them, and a ticket without `capacity` counts. A field of the wrong type reads as absent.
 */
interface Ticket {
  seq: number;
  id: string;
  pid: number;
  label: string;
  gated: boolean;
  capacity?: number;
  ready?: boolean;
  step?: number;
  ceiling?: number;
  override?: true;
}

function parseTicket(text: string): Ticket | null {
  try {
    const t = JSON.parse(text);
    if (!(Number.isFinite(t?.seq) && typeof t.id === "string" && isPid(t.pid))) return null;
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { ...t, capacity: num(t.capacity), step: num(t.step), ceiling: num(t.ceiling), ready: typeof t.ready === "boolean" ? t.ready : undefined, override: t.override === true ? true : undefined };
  } catch {
    return null;
  }
}

/**
 * Under the mutex: removes the tickets of dead processes and unparseable files, and returns the rest. A ticket is
 * `eligible` while its mtime is within 15 s of the clock; a stale one (its waiter was stopped) is passed over, not reaped,
 * and keeps its `seq` for when the waiter resumes.
 */
function scanTickets(opts: LeaseOptions, cls: LeaseClass): (Ticket & { eligible: boolean })[] {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = waitingDir(opts.dir, cls);
  const nowMs = now();
  const found: (Ticket & { eligible: boolean })[] = [];
  for (const name of (unlessGone(() => readdirSync(dir)) ?? []).filter((n) => n.endsWith(".json"))) {
    const text = unlessGone(() => readFileSync(join(dir, name), "utf8"));
    const mtimeMs = unlessGone(() => statSync(join(dir, name)).mtimeMs);
    if (text === undefined || mtimeMs === undefined) continue;
    const t = parseTicket(text);
    if (!t || !isAlive(t.pid)) rmSync(join(dir, name), { force: true });
    else found.push({ ...t, eligible: isWithinWindow(mtimeMs, nowMs, TICKET_FRESH_MS) });
  }
  return found;
}

/** Writes or refreshes a ticket, dating it on the lease clock before the rename so a reader never sees it with another mtime. */
function writeTicket(opts: LeaseOptions, cls: LeaseClass, t: Ticket): void {
  const file = join(waitingDir(opts.dir, cls), `${t.id}.json`);
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
 * The CPU gate, under the mutex. Busy is 1 minus the idle share of the ticks since the reading in `cpu.json`: a reading
 * under 2 s old is gated on as stored, one 2 to 10 s old is the base of a new delta (and is replaced), and an older,
 * future-dated or missing one is replaced and fails this poll, so the next has a delta. Unknown CPU passes.
 */
function cpuAdmits(opts: LeaseOptions, nowMs: number): boolean {
  let ticks: CpuTicks | undefined;
  try {
    ticks = opts.cpuTimes?.();
  } catch {
    return true;
  }
  if (!ticks || !(ticks.total > 0)) return true;
  const file = join(opts.dir, "cpu.json");
  const prev = unlessGone(() => parseCpuReading(readFileSync(file, "utf8")));
  const age = prev ? nowMs - prev.at : -1;
  if (prev && age >= 0 && age < CPU_REUSE_MS) return prev.busy !== null && prev.busy < GATE_CPU_BUSY;
  const span = prev ? ticks.total - prev.ticks.total : 0;
  const busy = prev && age >= 0 && age <= CPU_DELTA_MAX_MS && span > 0 ? 1 - (ticks.idle - prev.ticks.idle) / span : null;
  writeFileAtomic(file, JSON.stringify({ at: nowMs, ticks, busy }));
  return busy !== null && busy < GATE_CPU_BUSY;
}

/** The gates of a gated ticket. `cpuAdmits` always runs, since each poll keeps `cpu.json`'s delta fresh; a `lastAdmit` mark from the future reads as elapsed. */
function gatesPass(opts: LeaseOptions, live: HolderInfo[], nowMs: number): boolean {
  const cpu = cpuAdmits(opts, nowMs);
  const markedAt = unlessGone(() => statSync(join(opts.dir, "lastAdmit")).mtimeMs);
  const spaced = markedAt === undefined || markedAt > nowMs || nowMs - markedAt >= GATE_SPACING_MS;
  return cpu && spaced && !live.some((h) => h.suspended);
}

const removeTicket = (opts: LeaseOptions, cls: LeaseClass, id: string): void => rmSync(join(waitingDir(opts.dir, cls), `${id}.json`), { force: true });

/** What a ticket's owner could be admitted under now: its recorded ceiling at the machine step, its own override applied only if it has one. A ticket without the inputs keeps its recorded capacity, or counts. */
function ticketCapacity(cls: LeaseClass, t: Ticket, machineStep: number): number {
  if (t.ceiling === undefined) return t.capacity ?? Infinity;
  return cls.capacity(t.override && machineStep === 0 ? 1 : machineStep, t.ceiling);
}

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
  const file = join(holdersDir(opts.dir, cls), `${id}.json`);
  const rec: HolderRecord = { id, pid: detached?.sessionPid ?? process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
  if (detached) rec.expiresAt = detached.expiresAt;
  if (admission.override) rec.override = true;
  if (meta.suspendable) rec.suspendable = true;
  const write = (): void => writeFileAtomic(file, JSON.stringify(rec));
  write();
  let released = false;
  // A detached holder gets no heartbeat: its session PID and `expiresAt` keep it live.
  // Unref'd, so it never keeps the process alive. A file found gone was reaped: its heartbeat went stale (this event
  // loop stalled past 90 s, or the wall clock jumped) with no live child recorded. A heavy holder stays out of the count
  // for the rest of its run, so neither the beat (utimes never creates) nor setChildPid recreates the file. A
  // heartbeat-only holder (a session) is long-lived and its process resumed, so the beat writes it back, outside the
  // mutex: the pool may run over until it drains, and new admissions wait meanwhile.
  const beat = detached ? undefined : setInterval(() => {
    try {
      const at = now() / 1000;
      utimesSync(file, at, at);
    } catch (err) {
      // Reaped, or unwritable for now, which the next beat retries.
      if (!cls.heartbeatOnly || released || (err as NodeJS.ErrnoException).code !== "ENOENT") return;
      try {
        writeFileAtomic(file, JSON.stringify(rec), { mtimeMs: now() });
      } catch {
        // The next beat retries.
      }
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
    release(outcome) {
      if (released) return;
      released = true;
      clearInterval(beat);
      try {
        unlinkSync(file);
      } catch {
        // Already reaped.
      }
      emit(opts, { type: "release", id, heldMs: now() - rec.startedAt, ...(outcome?.exitCode !== undefined && { exitCode: outcome.exitCode }) });
    },
  };
}

function borrowedHandle(id: string, level: PressureLevel, capacity: number, live: number): LeaseHandle {
  return { id, leased: true, admission: { waitedMs: 0, level, live, capacity }, childEnv: () => ({ CO_LEASE_HOLDER: id }), setChildPid() {}, release() {} };
}

/**
 * One admission attempt for a holder class: sample the level, then count and write holders under the mutex. Admission is FIFO: a waiter
 * (`ticketId` set) is admitted when fewer tickets that count as ahead of its own than there are free slots, and a refused
 * one writes or refreshes its ticket. Without a `ticketId` (`tryAcquireLease`) it is admitted only when a slot is free
 * and no ticket counts as ahead, and writes none. Caller code (`warn`, `onEvent`) runs only after the mutex is released,
 * so a slow callback cannot outlive its staleness window.
 */
function attempt(opts: LeaseOptions, cls: LeaseClass, meta: HolderMeta, waitedMs: number, ticketId?: string): Attempt {
  const snap = snapshot(opts);
  const { level } = snap;
  const capacity = cls.slots(snap);
  const overridden = (opts.headroom ?? opts.level).overridden?.() === true;
  const command = recordedCommand(meta);
  const reaped: { id: string; reason: ReapReason }[] = [];
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
        rmSync(join(holdersDir(opts.dir, cls), `${d.id}.json`), { force: true });
        reaped.push(d);
      }
      const admission = { waitedMs, level, live: live.length + 1, capacity, ...(overridden && { override: true as const }) };
      // A second hook install for the same call acquires the id the first one holds: that call is already admitted.
      if (meta.detached && live.some((h) => h.id === meta.detached!.id)) r = { kind: "admitted", handle: borrowedHandle(meta.detached.id, level, capacity, live.length), borrowed: true };
      else {
        const line = scanTickets(opts, cls);
        const mine = line.find((t) => t.id === ticketId);
        const seq = mine?.seq ?? Math.max(0, ...line.map((t) => t.seq)) + 1;
        const nowMs = (opts.now ?? Date.now)();
        const free = capacity - live.length;
        const gated = meta.gated === true;
        // A ticket counts as ahead only while its owner could be admitted: it has a slot by its own ceiling at the current machine step (an override lifts step 0 to 1 only for its owner) and its gates passed at its last poll.
        const machineStep = overridden ? 0 : snap.step;
        const others = line.filter((t) => t.eligible && t.id !== ticketId && (ticketId === undefined || t.seq < seq) && ticketCapacity(cls, t, machineStep) > live.length);
        const ahead = others.filter((t) => t.ready !== false).length;
        // The gates are machine-wide, so a gated waiter waits for every older gated ticket that could be admitted, however many slots are free:
        // FIFO holds among gated tickets, and the next gated start's 20 s spacing goes to the oldest.
        const behindGated = gated && others.some((t) => t.gated);
        // No-wedge: with nothing live, the oldest gated ticket is admitted past its gates, except at step 0 (capacity 0 already refuses there; the clause keeps the rule true if a policy ever gives step 0 a slot).
        const ready = !gated || gatesPass(opts, live, nowMs) || (live.length === 0 && snap.step > 0);
        if (ready && !behindGated && ahead < (ticketId === undefined ? Math.min(free, 1) : free)) {
          if (gated) writeFileAtomic(join(opts.dir, "lastAdmit"), "", { mtimeMs: nowMs });
          r = { kind: "admitted", handle: createHolder(opts, cls, meta, command, admission) };
          try {
            if (mine) removeTicket(opts, cls, mine.id);
          } catch {
            // The holder exists, so the admission stands; a ticket that stays is removed when the waiter returns, or reaped once it exits.
          }
        } else {
          if (ticketId !== undefined) writeTicket(opts, cls, { seq, id: ticketId, pid: process.pid, label: command, gated, capacity, ready: ready && !behindGated, step: snap.step, ceiling: cls.ceiling(opts.policy), ...(overridden && { override: true as const }) });
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
    emit(opts, { type: "reap", id, reason });
  }
  if (r.kind === "admitted" && !r.borrowed) emit(opts, { type: "acquire", id: r.handle.id!, ...r.handle.admission, step: snap.step });
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
const emit = (opts: LeaseOptions, e: LeaseEvent): void => guarded(opts, opts.onEvent, e);

function failOpen(opts: LeaseOptions, level: PressureLevel, capacity: number, waitedMs: number, reason: "mutex-busy" | "io-error", error?: unknown): LeaseHandle {
  warn(opts, `lease: unavailable (${reason}); running unleased`);
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  emit(opts, { type: "fail-open", reason, waitedMs, ...(code !== undefined && { code }), ...(message !== undefined && { message }) });
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

/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. Throws a `TypeError` on an invalid detached id, session PID or `expiresAt`. */
export function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null {
  checkDetached(meta);
  const r = attempt(opts, HEAVY, meta, 0);
  if (r.kind === "admitted") return r.handle;
  return r.kind === "error" && r.level !== "critical" ? failOpen(opts, r.level, r.capacity, 0, "io-error", r.error) : null;
}

/** Live holders of `cls` (and of the session pool), or none when a directory cannot be read. */
function statusOf(opts: LeaseOptions, cls: LeaseClass, snap: Snapshot): LeaseStatus {
  const live = (of: LeaseClass): HolderInfo[] => {
    try {
      return scanHolders(opts, of).live;
    } catch {
      return [];
    }
  };
  const { level, step, signals } = snap;
  return { level, capacity: cls.slots(snap), step, signals, live: live(cls), sessions: { capacity: snap.sessions, live: live(SESSIONS) } };
}

/**
 * Polls (3 s ± 1 s, never spinning) until admitted, in the order waiters arrived: each waits behind a ticket in
 * `<dir>/waiting/`, which it removes when it is admitted, when it gives up and when this returns or throws. `stopWhen` is checked on every poll, and a stop is confirmed with a
 * `level.fresh()` re-read before it is returned, so one stale cached sample cannot end a wave. `onWait` runs on each poll
 * that neither admits nor refuses, and also receives `waitedMs`: the wait so far, measured on `LeaseOptions.now` the
 * same way as an admission's or refusal's `waitedMs`, so a progress line can throttle on it without a clock of its own.
 */
export const acquireLease = (opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait = {}): Promise<LeaseHandle | LeaseRefusal> => acquireIn(HEAVY, opts, meta, wait);

/**
 * `acquireLease` for the machine-wide implementer-session pool: holders in `<dir>/sessions/`, FIFO tickets in
 * `<dir>/sessions-waiting/`, capacity from the session row of the shared step (6, 4, 2, 1, 0 at steps 4 to 0, capped by
 * `CO_LEASE_SESSION_SLOTS`). A holder is live only while its heartbeat is, so a stopped engine frees its slots 90 s later;
 * no child PID extends it, and a holder reaped after a stall is written back on its next beat. There are no gates, no
 * detached holders and no suspendable mark: `meta.gated`, `meta.detached` and `meta.suspendable` are ignored.
 * The caller's `stopWhen` sees the session pool as `capacity` and `live`.
 */
export const acquireSessionLease = (opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait = {}): Promise<LeaseHandle | LeaseRefusal> =>
  acquireIn(SESSIONS, opts, { ...meta, gated: false, detached: undefined, suspendable: undefined }, wait);

async function acquireIn(cls: LeaseClass, opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait): Promise<LeaseHandle | LeaseRefusal> {
  checkDetached(meta);
  const ticketId = meta.detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
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
    if (r.level !== "critical") {
      if (r.kind === "error") return failOpen(opts, r.level, cls.slots(r), waitedMs, "io-error", r.error);
      if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS) return failOpen(opts, r.level, cls.slots(r), waitedMs, "mutex-busy");
    }
    const status = r.kind === "error" ? { level: r.level, capacity: cls.slots(r), step: r.step, signals: r.signals, live: [], sessions: { capacity: r.sessions, live: [] } } : statusOf(opts, cls, r);
    const refuse = (refused: LeaseRefusal["refused"], level: PressureLevel, live: number): LeaseRefusal => {
      emit(opts, { type: "timeout", refused, waitedMs, ...(refused === "stopped" && { level }) });
      return { refused, waitedMs, level, live };
    };
    if (wait.stopWhen?.(status)) {
      // The fresh read replaces the step and capacities only; the holders are the first scan's.
      const fresh = snapshot(opts, true);
      const confirmed: LeaseStatus = { ...status, level: fresh.level, step: fresh.step, signals: fresh.signals, capacity: cls.slots(fresh), sessions: { ...status.sessions, capacity: fresh.sessions } };
      if (wait.stopWhen(confirmed)) return refuse("stopped", confirmed.level, status.live.length);
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
  const dir = holdersDir(opts.dir, HEAVY);
  const ownDir = (d: string): boolean => {
    const st = unlessGone(() => lstatSync(d));
    return st !== undefined && isOwnDir(st);
  };
  if (!ownDir(opts.dir) || !ownDir(dir)) return false;
  const file = join(dir, `${id}.json`);
  const text = unlessGone(() => readFileSync(file, "utf8"));
  const rec = text === undefined ? null : parseHolder(text);
  if (rec?.expiresAt === undefined || unlessGone(() => (unlinkSync(file), true)) === undefined) return false;
  emit(opts, { type: "release", id, heldMs: (opts.now ?? Date.now)() - rec.startedAt });
  return true;
}

/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export function leaseStatus(opts: LeaseOptions): LeaseStatus {
  return statusOf(opts, HEAVY, snapshot(opts));
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
  const headroom = overrides.level ? undefined : defaultHeadroomSampler(env, { log: tagged });
  const level = overrides.level ?? levelView(headroom!);
  return {
    dir,
    level,
    ...(headroom && { headroom }),
    policy: pressurePolicyFromEnv(env, tagged),
    inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
    cpuTimes: osCpuTicks,
    onEvent: leaseEventSink(dir, { warn }),
    warn,
  };
}
