/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under the heavy capacity of the headroom step (`headroomCapacity(step, policy)`;
 * `heavyCapacity(level, policy)` when only a `level` sampler is given). Liveness is a live
 * heartbeat (the holder file's mtime, refreshed every 30 s) or a live child PID,
 * so a crashed or killed holder cannot leak a slot. A detached holder (hook mode) is live while its session PID is
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
  | { type: "timeout"; refused: "max-wait" | "stopped" | "disk-full"; waitedMs: number; level?: PressureLevel }
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
  capacity: number;
  /** The headroom step, 0 to 4; derived from `level` when no `headroom` sampler is set. */
  step: number;
  /** The kernel signals behind the step; `null` after a failed guarded read, and when no `headroom` sampler is set. */
  signals: MemorySignals | null;
  live: HolderInfo[];
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
  refused: "max-wait" | "stopped" | "disk-full";
  waitedMs: number;
  level: PressureLevel;
  live: number;
  /** The out-of-space error code of a `disk-full` refusal. */
  code?: string;
}

/** What one reading of the machine step means for this lease: the reading plus the heavy capacity it allows. */
type Snapshot = HeadroomReading & { capacity: number };

type Attempt =
  | { kind: "admitted"; handle: LeaseHandle; borrowed?: true }
  | ({ kind: "full" | "busy" } & Snapshot)
  | ({ kind: "error"; error: unknown } & Snapshot);

/** The machine step and its capacity; with no `headroom` sampler, today's level-only rule, and a step derived from the level. `fresh` bypasses every cache. */
function snapshot(opts: LeaseOptions, fresh = false): Snapshot {
  if (opts.headroom) {
    const reading = fresh ? opts.headroom.fresh() : opts.headroom();
    return { ...reading, capacity: headroomCapacity(reading.step, opts.policy) };
  }
  const level = fresh ? opts.level.fresh() : opts.level();
  const step = level === "critical" ? 0 : level === "warning" ? Math.min(MAX_STEP, opts.policy.heavyWarning) : MAX_STEP;
  return { level, step, signals: null, capacity: heavyCapacity(level, opts.policy) };
}

const holdersDir = (dir: string): string => join(dir, "holders");
const waitingDir = (dir: string): string => join(dir, "waiting");

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
 * while its child PID is alive and within the 2 h orphan bound, and else reaped as `stale-heartbeat`. The
 * wrapper PID is never consulted, so a recycled one cannot pin a slot. `null` is a file that is not a holder record.
 */
function verdict(rec: HolderRecord | null, mtimeMs: number, nowMs: number, alive: (pid: number) => boolean): "live" | ReapReason {
  if (!rec) return "corrupt";
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

function parseHolder(text: string): HolderRecord | null {
  try {
    const rec = JSON.parse(text);
    return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" && (rec.expiresAt === undefined || Number.isFinite(rec.expiresAt)) ? rec : null;
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
    const mtimeMs = unlessGone(() => statSync(join(dir, name)).mtimeMs);
    if (mtimeMs === undefined) continue;
    const v = verdict(rec, mtimeMs, nowMs, isAlive);
    if (v === "live") found.live.push({ ...rec!, ageSec: Math.round((nowMs - rec!.startedAt) / 1000) });
    else found.dead.push({ id: name.slice(0, -".json".length), reason: v });
  }
  return found;
}

/**
 * A heavy waiter's place in line. `capacity` is what its owner last computed and `ready` whether its gates passed then;
 * a ticket whose owner could not be admitted does not hold up the line. Builds that predate the two fields write neither,
 * and such a ticket counts.
 */
interface Ticket {
  seq: number;
  id: string;
  pid: number;
  label: string;
  gated: boolean;
  capacity?: number;
  ready?: boolean;
}

function parseTicket(text: string): Ticket | null {
  try {
    const t = JSON.parse(text);
    return Number.isFinite(t?.seq) && typeof t.id === "string" && isPid(t.pid) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Under the mutex: removes the tickets of dead processes and unparseable files, and returns the rest. A ticket is
 * `eligible` while its mtime is within 15 s of the clock; a stale one (its waiter was stopped) is passed over, not reaped,
 * and keeps its `seq` for when the waiter resumes.
 */
function scanTickets(opts: LeaseOptions): (Ticket & { eligible: boolean })[] {
  const { isAlive = pidAlive, now = Date.now } = opts;
  const dir = waitingDir(opts.dir);
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
function writeTicket(opts: LeaseOptions, t: Ticket): void {
  const file = join(waitingDir(opts.dir), `${t.id}.json`);
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
  const prev = unlessGone(() => parseCpuReading(readFileSync(file, "utf8")));
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

const removeTicket = (opts: LeaseOptions, id: string): void => rmSync(join(waitingDir(opts.dir), `${id}.json`), { force: true });

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

function createHolder(opts: LeaseOptions, meta: HolderMeta, command: string, admission: LeaseHandle["admission"]): LeaseHandle {
  const now = opts.now ?? Date.now;
  const { detached } = meta;
  const id = detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  const file = join(holdersDir(opts.dir), `${id}.json`);
  const rec: HolderRecord = { id, pid: detached?.sessionPid ?? process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
  if (detached) rec.expiresAt = detached.expiresAt;
  if (admission.override) rec.override = true;
  if (meta.suspendable) rec.suspendable = true;
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
 * One admission attempt: sample the level, then count and write holders under the mutex. Admission is FIFO: a waiter
 * (`ticketId` set) is admitted when fewer eligible tickets are ahead of its own than there are free slots, and a refused
 * one writes or refreshes its ticket. Without a `ticketId` (`tryAcquireLease`) it is admitted only when a slot is free
 * and no eligible ticket waits, and writes none. Caller code (`warn`, `onEvent`) runs only after the mutex is released,
 * so a slow callback cannot outlive its staleness window.
 */
function attempt(opts: LeaseOptions, meta: HolderMeta, waitedMs: number, ticketId?: string): Attempt {
  const snap = snapshot(opts);
  const { level, capacity } = snap;
  const overridden = (opts.headroom ?? opts.level).overridden?.() === true;
  const command = recordedCommand(meta);
  const reaped: { id: string; reason: ReapReason }[] = [];
  let r: Attempt;
  try {
    ensureOwnSubdir(opts.dir, "holders");
    ensureOwnSubdir(opts.dir, "waiting");
    const scan = scanHolders(opts);
    if (opts.inheritedHolderId && scan.live.some((h) => h.id === opts.inheritedHolderId)) {
      return { kind: "admitted", handle: borrowedHandle(opts.inheritedHolderId, level, capacity, scan.live.length) };
    }
    const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
    if (!lock) return { kind: "busy", ...snap };
    try {
      const { live, dead } = scanHolders(opts);
      for (const d of dead) {
        rmSync(join(holdersDir(opts.dir), `${d.id}.json`), { force: true });
        reaped.push(d);
      }
      const admission = { waitedMs, level, live: live.length + 1, capacity, ...(overridden && { override: true as const }) };
      // A second hook install for the same call acquires the id the first one holds: that call is already admitted.
      if (meta.detached && live.some((h) => h.id === meta.detached!.id)) r = { kind: "admitted", handle: borrowedHandle(meta.detached.id, level, capacity, live.length), borrowed: true };
      else {
        const line = scanTickets(opts);
        const mine = line.find((t) => t.id === ticketId);
        const seq = mine?.seq ?? Math.max(0, ...line.map((t) => t.seq)) + 1;
        const nowMs = (opts.now ?? Date.now)();
        const free = capacity - live.length;
        const gated = meta.gated === true;
        // A ticket counts as ahead only while its owner could be admitted: it has a slot by its own capacity and its gates passed at its last poll.
        const others = line.filter((t) => t.eligible && t.id !== ticketId && (ticketId === undefined || t.seq < seq) && (t.capacity ?? Infinity) > live.length);
        const ahead = others.filter((t) => t.ready !== false).length;
        // The gates are machine-wide, so a gated waiter waits for every older gated ticket that could be admitted, however many slots are free:
        // FIFO holds among gated tickets, and the next gated start's 20 s spacing goes to the oldest.
        const behindGated = gated && others.some((t) => t.gated);
        // No-wedge: with nothing live, the oldest gated ticket is admitted past its gates, except at step 0 (capacity 0 already refuses there; the clause keeps the rule true if a policy ever gives step 0 a slot).
        const ready = !gated || gatesPass(opts, live, nowMs) || (live.length === 0 && snap.step > 0 && !others.some((t) => t.gated));
        if (ready && !behindGated && ahead < (ticketId === undefined ? Math.min(free, 1) : free)) {
          if (gated) writeMark(opts.dir, "lastAdmit", nowMs);
          r = { kind: "admitted", handle: createHolder(opts, meta, command, admission) };
          try {
            if (mine) removeTicket(opts, mine.id);
          } catch {
            // The holder exists, so the admission stands; a ticket that stays is removed when the waiter returns, or reaped once it exits.
          }
        } else {
          if (ticketId !== undefined) writeTicket(opts, { seq, id: ticketId, pid: process.pid, label: command, gated, capacity, ready: ready && !behindGated });
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

/** An out-of-space error: the lease refuses instead of failing open, since unleased builds are the worst load on a full disk. Nothing is written to report it. */
const diskFullCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? code : undefined;
};

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

/** A single non-blocking attempt: a handle, or `null` when not admitted this poll (a full disk included: it is never failed open, and emits a `timeout` event with `refused: "disk-full"`). Throws a `TypeError` on an invalid detached id, session PID or `expiresAt`. */
export function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null {
  checkDetached(meta);
  const r = attempt(opts, meta, 0);
  if (r.kind === "admitted") return r.handle;
  const code = r.kind === "error" ? diskFullCode(r.error) : undefined;
  if (code !== undefined) {
    emit(opts, { type: "timeout", refused: "disk-full", waitedMs: 0 });
    return null;
  }
  return r.kind === "error" && r.level !== "critical" ? failOpen(opts, r.level, r.capacity, 0, "io-error", r.error) : null;
}

/** Live holders, or none when the directory cannot be read. */
function statusOf(opts: LeaseOptions, { level, capacity, step, signals }: Snapshot): LeaseStatus {
  try {
    return { level, capacity, step, signals, live: scanHolders(opts).live };
  } catch {
    return { level, capacity, step, signals, live: [] };
  }
}

/**
 * Polls (3 s ± 1 s, never spinning) until admitted, in the order waiters arrived: each waits behind a ticket in
 * `<dir>/waiting/`, which it removes when it is admitted, when it gives up and when this returns or throws. `stopWhen` is checked on every poll, and a stop is confirmed with a
 * `level.fresh()` re-read before it is returned, so one stale cached sample cannot end a wave. `onWait` runs on each poll
 * that neither admits nor refuses, and also receives `waitedMs`: the wait so far, measured on `LeaseOptions.now` the
 * same way as an admission's or refusal's `waitedMs`, so a progress line can throttle on it without a clock of its own.
 */
export async function acquireLease(opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait = {}): Promise<LeaseHandle | LeaseRefusal> {
  checkDetached(meta);
  const ticketId = meta.detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    return await pollForLease(opts, meta, wait, ticketId);
  } finally {
    try {
      removeTicket(opts, ticketId);
    } catch {
      // A ticket that stays is reaped once this process exits.
    }
  }
}

type LeaseWait = { maxWaitMs?: number; onWait?(s: LeaseStatus & { waitedMs: number }): void; stopWhen?(s: LeaseStatus): boolean };

async function pollForLease(opts: LeaseOptions, meta: HolderMeta, wait: LeaseWait, ticketId: string): Promise<LeaseHandle | LeaseRefusal> {
  const { now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = POLL_MS } = opts;
  const start = now();
  let busySince: number | undefined;
  for (;;) {
    const waitedMs = now() - start;
    const r = attempt(opts, meta, waitedMs, ticketId);
    if (r.kind === "admitted") return r.handle;
    busySince = r.kind === "busy" ? (busySince ?? now()) : undefined;
    const code = r.kind === "error" ? diskFullCode(r.error) : undefined;
    if (code !== undefined) {
      emit(opts, { type: "timeout", refused: "disk-full", waitedMs });
      return { refused: "disk-full", waitedMs, level: r.level, live: 0, code };
    }
    if (r.level !== "critical") {
      if (r.kind === "error") return failOpen(opts, r.level, r.capacity, waitedMs, "io-error", r.error);
      if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS) return failOpen(opts, r.level, r.capacity, waitedMs, "mutex-busy");
    }
    const status = r.kind === "error" ? { level: r.level, capacity: r.capacity, step: r.step, signals: r.signals, live: [] } : statusOf(opts, r);
    const refuse = (refused: LeaseRefusal["refused"], level: PressureLevel, live: number): LeaseRefusal => {
      emit(opts, { type: "timeout", refused, waitedMs, ...(refused === "stopped" && { level }) });
      return { refused, waitedMs, level, live };
    };
    if (wait.stopWhen?.(status)) {
      const confirmed = snapshot(opts, true);
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
  const dir = holdersDir(opts.dir);
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
  return statusOf(opts, snapshot(opts));
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
