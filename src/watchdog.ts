/**
 * The watchdog's scan-and-classify core: one bounded `ps` scan, a list of rules over it, and reporters that write
 * `watchdog.json`, `watchdog.brief` and `watchdog.log` in the lease directory. It runs outside every engine tree, so a
 * stopped tree cannot silence it. It sends no signal: its dependencies are `ps`, the clock and the file system, and an
 * engine's liveness is whether its pid has a row in the scan for a process that started no later than the record.
 */
import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeBoundedFailure } from "./bounded-failure.js";
import { REFRESH_MS } from "./engine-registry.js";
import { isWithinWindow } from "./file-lock.js";
import { appendOwnLine, isOwnDir, readLeaseRecord, readOwnFile, readRecordDir, writeLeaseRecord } from "./lease-dir.js";
import { ancestry, hungTestCandidates, isBuildToolProcess, isClaudeCommand, isPid, isSimulatorCommand, parsePsTable, ps, PS_TABLE_ARGS, runsTool, simulatorUdid, XCODE_TOOLS, xcTestDeviceUdid, type ProcRow } from "./ps.js";
import type { ReapInput, ReapResult } from "./simulator-reaper.js";
import { isLeaseRecord, readSuspensions, type SuspensionRecord } from "./suspensions.js";

const EX_USAGE = 64;
const USAGE = "usage: claude-orchestrator-watchdog check | brief | print-plist | print-status-line";
/** A stopped group with no suspension record is reported this long after it was first seen stopped. */
export const STOPPED_AFTER_MS = 5 * 60_000;
/** An engine record is fresh for three refresh periods, the lease's heartbeat rule. */
export const ENGINE_FRESH_MS = 3 * REFRESH_MS;
/** A stale engine record whose pid is alive and running is reported once it is older than the engine's `stallTimeout` plus this. */
export const STALLED_MARGIN_MS = 10 * 60_000;
/** A lease suspension (`by: "lease"`) older than this is reported. */
export const LEASE_SUSPENSION_MAX_MS = 30 * 60_000;

/** A booted simulator with no `xcodebuild` or `simctl` running is reported this long after it was first seen idle. */
export const SIMULATOR_IDLE_AFTER_MS = 5 * 60_000;

/** An `engines/<pid>.json` record (see `engine-registry.ts`) with the verdicts the rules need. */
export interface Engine {
  pid: number;
  pgid: number | null;
  runId: string;
  logDir: string;
  stallTimeout: number;
  startedAt: string;
  /** The record's mtime is within `ENGINE_FRESH_MS` of the clock. */
  fresh: boolean;
  /** The pid has a row in the scan, for a process that started no later than the record's `startedAt` (a later one holds a reused pid). */
  alive: boolean;
  /** The record's mtime: how long ago the engine last refreshed it. */
  mtimeMs: number;
  /** The engine's own scan row has a `stat` starting with `T`. */
  stopped: boolean;
  /** The newest mtime of `<logDir>/*.log`, else the record's `startedAt`; NaN when neither is readable. Read only for a fresh record that has a silence check. */
  activityMs: number;
}

/** One thing to tell the owner. `once` findings are emitted in one cycle per `key` while the thing they describe lasts. */
export interface Finding {
  key: string;
  message: string;
  once?: boolean;
}

/** What a rule sees: the scan, the registry and the suspension records, all read once per cycle. */
export interface Context {
  now: number;
  procs: ProcRow[];
  engines: Engine[];
  /** Groups with a valid suspension record (`readSuspensions`). */
  suspended: Set<number>;
  /** The valid suspension records themselves. */
  records: SuspensionRecord[];
  /** In-scope stopped groups, with the time each was first seen stopped. */
  stoppedSince: Map<number, number>;
  /** Booted simulators with no `xcodebuild` or `simctl` anywhere in the scan, by UDID: when each was first seen idle and its readable rss total (`undefined` when no row's rss is readable). `xctest` marks a clone of the XCTestDevices set, which only the reaper acts on; the report is for main-set devices. */
  idleSimulators: Map<string, { since: number; rssBytes: number | undefined; xctest: boolean }>;
  /** The live, unexpired holders of the UI-test class (`ui-tests/`) with the time each started: a test process that started after one could be its run. */
  uiHolders: { startedAt: number }[];
}

export type Rule = (c: Context) => Finding[];

const minutes = (ms: number): number => Math.floor(ms / 60_000);
/** Slack on the pid-reuse check: `etime` has one-second resolution and the registry stamps `startedAt` just after the engine starts. */
const START_SLACK_MS = 5_000;

const unrecordedStoppedGroup: Rule = (c) =>
  [...c.stoppedSince]
    .filter(([pgid, since]) => !c.suspended.has(pgid) && c.now - since >= STOPPED_AFTER_MS)
    .map(([pgid, since]) => ({ key: `stopped:${pgid}`, message: `process group ${pgid} stopped ${minutes(c.now - since)}m, no suspension record` }));

// A stale record whose pid is alive is a stopped or wedged engine. Its sessions share its group, so the group is
// rarely stopped throughout, and the engine is reported on its own: on the stopped-group bound when its own stat is T,
// and otherwise (running, but not refreshing) only past its stallTimeout + 10 minutes, since a healthy engine stops
// refreshing while a long synchronous command blocks its event loop. At stallTimeout 0 (no silence check) a running
// engine is never reported. The report yields once the stopped-group rule reports the group, and a group with a
// suspension record is skipped.
const stalledAfterMs = (e: Engine): number => (e.stopped ? STOPPED_AFTER_MS : e.stallTimeout > 0 ? e.stallTimeout * 1000 + STALLED_MARGIN_MS : Infinity);

const stalledEngine: Rule = (c) =>
  c.engines
    .filter((e) => !e.fresh && e.alive && c.now - e.mtimeMs >= stalledAfterMs(e))
    .filter((e) => e.pgid === null || !(c.suspended.has(e.pgid) || c.now - (c.stoppedSince.get(e.pgid) ?? c.now) >= STOPPED_AFTER_MS))
    .map((e) => ({ key: `stalled:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) has not refreshed its record for ${minutes(c.now - e.mtimeMs)}m and is still alive: stopped or wedged` }));

const deadEngine: Rule = (c) =>
  c.engines
    .filter((e) => !e.fresh && !e.alive)
    .map((e) => ({ key: `dead:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) died, its record is left in engines/`, once: true }));

// A due reminder is reported while the recorded group is stopped throughout, whatever tree it is in (`c.stoppedSince`
// holds only in-scope groups). A recorded group with no live members is a stale record, reported once and kept.
const dueReminder: Rule = (c) =>
  c.records
    .filter((r) => Date.parse(r.remindAt) <= c.now)
    .flatMap((r): Finding[] => {
      const members = c.procs.filter((p) => p.pgid === r.pgid);
      if (members.length === 0) return [{ key: `stale-record:${r.pgid}`, message: `suspension record for process group ${r.pgid} has no live members, left in suspensions/`, once: true }];
      return members.every((p) => p.stat.startsWith("T")) ? [{ key: `reminder:${r.pgid}`, message: `process group ${r.pgid} is still suspended by ${r.by} (${r.reason}), reminder due` }] : [];
    });

const oldLeaseSuspension: Rule = (c) =>
  c.records
    .filter((r) => isLeaseRecord(r) && c.now - Date.parse(r.at) >= LEASE_SUSPENSION_MAX_MS)
    .map((r) => ({ key: `lease-suspended:${r.pgid}`, message: `process group ${r.pgid} suspended by the lease ${minutes(c.now - Date.parse(r.at))}m (${r.reason})` }));

// A fresh record is refreshing, so a silent engine is a live one that writes no session log: exclusive with stalledEngine by freshness.
const silentEngine: Rule = (c) =>
  c.engines
    .filter((e) => e.fresh && e.stallTimeout > 0 && c.now - e.activityMs > e.stallTimeout * 1000 + STALLED_MARGIN_MS)
    .map((e) => ({ key: `silent:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) wrote no session log for ${minutes(c.now - e.activityMs)}m` }));

// Report only, for main-set devices: the owner runs the suggested `simctl shutdown` (a device may be in use by hand), the watchdog never does.
const idleSimulator: Rule = (c) =>
  [...c.idleSimulators]
    .filter(([, d]) => !d.xctest && c.now - d.since >= SIMULATOR_IDLE_AFTER_MS)
    .map(([udid, d]) => ({
      key: `sim-idle:${udid}`,
      message: `simulator ${udid} booted and idle ${minutes(c.now - d.since)}m${d.rssBytes === undefined ? "" : `, holding ${(d.rssBytes / 2 ** 30).toFixed(1)} GB`}; to reclaim it run: xcrun simctl shutdown ${udid}`,
      once: true,
    }));

/** A test in progress with no live UI-test holder that could own it is reported once it has run this long. */
export const HUNG_TEST_AFTER_MS = 30 * 60_000;
/** Clock slack when asking whether a process started after a holder did. */
const HOLDER_START_SLACK_MS = 5_000;

// Report only: a test process that hangs, or a runner left behind by a killed run, holds the machine in fact with no holder to show for it: simulator reaping
// stands down (its test-action guard), and UI-test runs wait behind it (the lease's process scan: always for a build tool test action, while Xcode.app runs
// for a runner or simulator xctest). Only a live, unexpired holder that started no later than the process could own it; a file that merely exists, an expired
// holder, a holder whose process is gone, or a process older than the holder suppresses nothing. The watchdog names it and never touches it.
const hungTestAction: Rule = (c) =>
  hungTestCandidates(c.procs)
    .filter((p) => p.elapsedMs >= HUNG_TEST_AFTER_MS && !c.uiHolders.some((h) => h.startedAt <= c.now - p.elapsedMs + HOLDER_START_SLACK_MS))
    .map((p) => ({
      key: `hung-test:${p.pid}`,
      message: `test process pid ${p.pid} has run ${age(p.elapsedMs)} with no UI-test lease holder that could own it (hung, or left behind by a killed run?): UI-test runs wait behind it (always for a build tool test action; for a runner or simulator xctest only while Xcode.app runs and its device has a launchd_sim), and simulator reaping is paused by a build tool test action or a runner that names no device (the reaper signals a runner whose device reads Shutdown); it is left running, not killed`,
    }));

const age = (ms: number): string => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${String(minutes(ms % 3_600_000)).padStart(2, "0")}m` : `${minutes(ms)}m`);

/** The rules, in report order. A rule reads the context and returns findings; the reporters never change. */
export const RULES: Rule[] = [unrecordedStoppedGroup, dueReminder, oldLeaseSuspension, stalledEngine, silentEngine, deadEngine, idleSimulator, hungTestAction];

/** The scan's bound, 60 s because `ps` can be slow at background priority. */
export const SCAN_TIMEOUT_MS = 60_000;
/** The default scan: one bounded `ps`. A throw skips the cycle. */
export const scanProcessTable = (): string => ps(PS_TABLE_ARGS, { timeoutMs: SCAN_TIMEOUT_MS });

export interface WatchdogDeps {
  /** The lease directory. */
  dir: string;
  scan: () => string;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The volume reader behind `brief`'s disk-full line (default `statfsSync`). */
  statfs?: (dir: string) => { bavail: number; blocks: number };
  /** Reaps leftover simulator processes and shuts down idle booted devices once per cycle, after the scan: given the devices idle for `SIMULATOR_IDLE_AFTER_MS` and the last cycle's attempts, it returns the attempts to carry on. Absent, nothing is reaped. */
  reap?: (input: ReapInput) => ReapResult;
}

interface State {
  stoppedSince: Record<string, number>;
  /** When each booted simulator, by UDID, was first seen idle. */
  idleSimulators: Record<string, number>;
  /** Cycles each shut-down device's leftover processes have been signalled, by UDID (`ReapInput.attempts`). */
  simReaps: Record<string, number>;
  /** The pids each shut-down device's leftovers read with on the last cycle (`ReapInput.seen`). */
  simSeen: Record<string, number[]>;
  /** Keys of `once` findings already emitted. */
  reported: string[];
  /** The latest cycle's emitted findings. */
  findings: Finding[];
}

/** Whether `row` can be the process that wrote a record started at `startedAt`: one that started later holds a reused pid. An unreadable time on either side keeps the row. */
function isSameProcess(row: ProcRow, startedAt: unknown, now: number): boolean {
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  return !(now - row.elapsedMs > started + START_SLACK_MS);
}

/** The newest mtime among the regular `*.log` files directly in `logDir`, else the record's `startedAt` (NaN when unreadable). */
function activityOf(logDir: unknown, startedAt: unknown): number {
  let newest = -Infinity;
  try {
    for (const n of readdirSync(String(logDir)).filter((n) => n.endsWith(".log"))) {
      const st = statSync(join(String(logDir), n), { throwIfNoEntry: false });
      if (st?.isFile()) newest = Math.max(newest, st.mtimeMs);
    }
  } catch {}
  return newest > -Infinity ? newest : typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
}

function readEngines(dir: string, now: number, procs: ProcRow[]): Engine[] {
  return readRecordDir(dir, "engines").flatMap(({ text, mtimeMs }) => {
    let r: any;
    try {
      r = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isPid(r?.pid) || typeof r.runId !== "string") return [];
    const row = procs.find((p) => p.pid === r.pid);
    // A null pgid (ps failed at engine start) falls back to the scan's.
    const fresh = isWithinWindow(mtimeMs, now, ENGINE_FRESH_MS);
    const stallTimeout = Number.isFinite(r.stallTimeout) && r.stallTimeout >= 0 ? r.stallTimeout : 0;
    return [{ ...r, pgid: Number.isInteger(r.pgid) ? r.pgid : (row?.pgid ?? null), fresh, alive: row !== undefined && isSameProcess(row, r.startedAt, now), mtimeMs, stopped: row?.stat.startsWith("T") ?? false, stallTimeout, activityMs: fresh && stallTimeout > 0 ? activityOf(r.logDir, r.startedAt) : NaN }];
  });
}

/** Groups whose every member is stopped (`stat` starts with `T`) and that contain or descend from a `claude` process, or belong to a live registered engine. */
function stoppedGroups(procs: ProcRow[], engines: Engine[]): number[] {
  const isClaude = (p: ProcRow): boolean => isClaudeCommand(p.command);
  const underClaude = (p: ProcRow): boolean => ancestry(procs, p.pid, 64).chain.some(isClaude);
  const enginePgids = new Set(engines.filter((e) => e.alive).map((e) => e.pgid));
  const groups = new Map<number, ProcRow[]>();
  for (const p of procs) groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
  return [...groups].filter(([pgid, members]) => members.every((p) => p.stat.startsWith("T")) && (enginePgids.has(pgid) || members.some(underClaude))).map(([pgid]) => pgid);
}

/** Booted simulators by UDID (the `launchd_sim` row naming `Devices/<udid>/`, or `XCTestDevices/<udid>/` for a test clone) with the readable rss of every simulator process under it, one pid map for the scan. Idle ones only: none when an `xcodebuild` or `simctl` is running. */
function idleSimulatorRss(procs: ProcRow[]): Map<string, { rssBytes: number | undefined; xctest: boolean }> {
  // A process that is the build tool or simctl itself keeps a device from being idle; a command line that only holds their names does not.
  const toolRunning = procs.some((p) => isBuildToolProcess(p.command));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const roots = new Map(procs.flatMap((p) => {
    if (!p.command.includes("launchd_sim")) return [];
    const udid = simulatorUdid(p.command) ?? xcTestDeviceUdid(p.command);
    return udid ? [[p.pid, { udid, xctest: simulatorUdid(p.command) === undefined }] as const] : [];
  }));
  const totals = new Map<string, { rssBytes: number | undefined; xctest: boolean }>();
  if (toolRunning) return totals;
  for (const { udid, xctest } of roots.values()) totals.set(udid, { rssBytes: undefined, xctest });
  for (const p of procs.filter((p) => isSimulatorCommand(p.command))) {
    let up: ProcRow | undefined = p;
    for (let i = 0; up && i < 64 && !roots.has(up.pid); i++) up = byPid.get(up.ppid);
    const root = up && roots.get(up.pid);
    if (root && Number.isFinite(p.rssBytes)) totals.set(root.udid, { ...totals.get(root.udid)!, rssBytes: (totals.get(root.udid)?.rssBytes ?? 0) + p.rssBytes });
  }
  return totals;
}

/** A holder is live while its detached session is alive and `expiresAt` has not passed, or while its heartbeat is fresh (90 s, the lease's rule) or its child is alive. */
const HOLDER_HEARTBEAT_MS = 90_000;

/** The live UI-test holders, read without reaping (a missing, symlinked or foreign directory, an unreadable or malformed file has none). */
function liveUiHolders(dir: string, procs: ProcRow[], now: number): { startedAt: number }[] {
  try {
    const sub = join(dir, "ui-tests");
    const st = lstatSync(sub, { throwIfNoEntry: false });
    if (st === undefined || !isOwnDir(st)) return [];
    const alive = (pid: unknown): boolean => procs.some((p) => p.pid === pid);
    return readdirSync(sub).flatMap((name) => {
      if (!name.endsWith(".json")) return [];
      try {
        const file = readOwnFile(join(sub, name));
        const rec = file && JSON.parse(file.text);
        if (!rec || !isPid(rec.pid) || typeof rec.startedAt !== "number") return [];
        const live = typeof rec.expiresAt === "number" ? now < rec.expiresAt && alive(rec.pid) : isWithinWindow(file.mtimeMs, now, HOLDER_HEARTBEAT_MS) || (isPid(rec.childPid) && alive(rec.childPid));
        return live ? [{ startedAt: rec.startedAt as number }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function readState(dir: string): State {
  try {
    const s = JSON.parse(readLeaseRecord(dir, "watchdog.json")?.text ?? "{}");
    return { stoppedSince: s.stoppedSince ?? {}, idleSimulators: s.idleSimulators ?? {}, simReaps: s.simReaps ?? {}, simSeen: s.simSeen ?? {}, reported: s.reported ?? [], findings: s.findings ?? [] };
  } catch {
    return { stoppedSince: {}, idleSimulators: {}, simReaps: {}, simSeen: {}, reported: [], findings: [] };
  }
}

/** Appends one line to `watchdog.log` through `appendOwnLine`: only a regular file this user owns is appended to (a symlink is not followed, a FIFO not waited on), and a new one has mode 0600. A failure is swallowed: the log is a diagnostic. */
function appendLog(dir: string, now: number, text: string): void {
  try {
    appendOwnLine(join(dir, "watchdog.log"), `${new Date(now).toISOString()} ${text}`);
  } catch {}
}

/**
 * One cycle: scan, run every rule, then write `watchdog.json`, `watchdog.brief` (the one-line summary, empty when all
 * is well) and `watchdog.log` (each newly emitted finding). Writes nothing unless the lease directory passes the
 * lease's directory rule, and never creates it. A scan that throws or returns no rows skips the cycle: the previous
 * state stays and the skip is logged. A dead engine's record is reported once per `runId` and never deleted.
 */
export function check(d: WatchdogDeps): void {
  const st = lstatSync(d.dir, { throwIfNoEntry: false });
  if (!st || !isOwnDir(st)) return;
  const now = d.now();
  const prev = readState(d.dir);
  let procs: ProcRow[];
  try {
    procs = parsePsTable(d.scan());
    if (procs.length === 0) throw new Error("empty process table");
  } catch (err) {
    appendLog(d.dir, now, `scan skipped: ${describeBoundedFailure(err, SCAN_TIMEOUT_MS)}`);
    return;
  }
  const engines = readEngines(d.dir, now, procs);
  const stoppedSince = new Map(stoppedGroups(procs, engines).map((pgid) => [pgid, prev.stoppedSince[pgid] ?? now]));
  const idleSimulators = new Map([...idleSimulatorRss(procs)].map(([udid, d]) => [udid, { since: prev.idleSimulators[udid] ?? now, ...d }]));
  let simReaps = prev.simReaps;
  let simSeen = prev.simSeen;
  try {
    const idleUdids = [...idleSimulators].filter(([, v]) => now - v.since >= SIMULATOR_IDLE_AFTER_MS).map(([udid]) => udid);
    const reaped = d.reap?.({ procs, idleUdids, attempts: prev.simReaps, seen: prev.simSeen });
    simReaps = reaped?.attempts ?? simReaps;
    simSeen = reaped?.seen ?? simSeen;
  } catch (err) {
    appendLog(d.dir, now, `simulator reaping failed: ${(err as Error).message}`);
  }
  const records = readSuspensions(d.dir);
  const suspended = new Set(records.map((r) => r.pgid));
  const found = RULES.flatMap((rule) => rule({ now, procs, engines, suspended, records, stoppedSince, idleSimulators, uiHolders: liveUiHolders(d.dir, procs, now) }));
  const findings = found.filter((f) => !(f.once && prev.reported.includes(f.key)));
  const state: State = { stoppedSince: Object.fromEntries(stoppedSince), idleSimulators: Object.fromEntries([...idleSimulators].map(([udid, d]) => [udid, d.since])), simReaps, simSeen, reported: found.filter((f) => f.once).map((f) => f.key), findings };
  writeLeaseRecord(d.dir, "watchdog.json", JSON.stringify({ checkedAt: new Date(now).toISOString(), ...state }));
  writeLeaseRecord(d.dir, "watchdog.brief", findings.length ? `watchdog: ${findings.map((f) => f.message).join("; ")}` : "");
  for (const f of findings) if (!prev.findings.some((p) => p.key === f.key)) appendLog(d.dir, now, f.message);
}

/** Free fraction of the lease directory's volume below which `brief` reports a full disk. */
export const DISK_FULL_FRACTION = 0.02;

/** The disk-full line's text; `print-status-line` reuses it so the shell and `brief` say the same thing. */
export function diskFullText(dir: string, pct: string): string {
  return `watchdog: the disk holding ${dir} is nearly full (${pct}% free); heavy commands are refused once the lease cannot write`;
}

/** A disk-full line when the lease directory's volume is nearly out of space, read live (a full disk fails every record write), else `""`. */
function diskFullLine(dir: string, statfs: NonNullable<WatchdogDeps["statfs"]>): string {
  try {
    const { bavail, blocks } = statfs(dir);
    return blocks > 0 && bavail / blocks < DISK_FULL_FRACTION ? diskFullText(dir, ((bavail / blocks) * 100).toFixed(1)) : "";
  } catch {
    return "";
  }
}

/** Runs `check` or `brief` (`argv[0]`): exit 0 done, 64 usage. `brief` prints `watchdog.brief` (nothing when it is empty or missing), then a disk-full line when the volume is nearly full (a live `statfsSync`, no file written). */
export function runWatchdog(argv: string[], d: WatchdogDeps): number {
  if (argv.length !== 1 || (argv[0] !== "check" && argv[0] !== "brief")) {
    d.err(USAGE);
    return EX_USAGE;
  }
  if (argv[0] === "check") check(d);
  else {
    const line = readLeaseRecord(d.dir, "watchdog.brief")?.text;
    if (line) d.out(line);
    const full = diskFullLine(d.dir, d.statfs ?? statfsSync);
    if (full) d.out(full);
  }
  return 0;
}
