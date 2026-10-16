/**
 * The watchdog's scan-and-classify core: one bounded `ps` scan, a list of rules over it, and reporters that write
 * `watchdog.json`, `watchdog.brief` and `watchdog.log` in the lease directory. It runs outside every engine tree, so a
 * stopped tree cannot silence it. It sends no signal: its dependencies are `ps`, the clock and the file system, and an
 * engine's liveness is whether its pid has a row in the scan for a process that started no later than the record.
 */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REFRESH_MS } from "./engine-registry.js";
import { isWithinWindow } from "./file-lock.js";
import { isOwnDir, writeLeaseRecord } from "./lease-dir.js";
import { isPid } from "./lease.js";
import { ps } from "./ps.js";
import { readSuspensions } from "./suspensions.js";

const EX_USAGE = 64;
const USAGE = "usage: claude-orchestrator-watchdog check | brief";
/** A stopped group with no suspension record is reported this long after it was first seen stopped. */
export const STOPPED_AFTER_MS = 5 * 60_000;
/** An engine record is fresh for three refresh periods, the lease's heartbeat rule. */
export const ENGINE_FRESH_MS = 3 * REFRESH_MS;
/** A stale engine record whose pid is alive and running is reported once it is older than the engine's `stallTimeout` plus this. */
export const STALLED_MARGIN_MS = 10 * 60_000;
// A planted symlink is not followed and a planted FIFO is not waited on.
const LOG_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  /** Time since the process started (`ps` `etime`), or NaN when the column cannot be read. */
  elapsedMs: number;
  command: string;
}

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
  procs: Proc[];
  engines: Engine[];
  /** Groups with a valid suspension record (`readSuspensions`). */
  suspended: Set<number>;
  /** In-scope stopped groups, with the time each was first seen stopped. */
  stoppedSince: Map<number, number>;
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

/** The rules, in report order. A rule reads the context and returns findings; the reporters never change. */
export const RULES: Rule[] = [unrecordedStoppedGroup, stalledEngine, deadEngine];

/** The default scan: one bounded `ps`, 60 s because it can be slow at background priority. A throw skips the cycle. */
export const scanProcessTable = (): string => ps(["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,command="], { timeoutMs: 60_000 });

export interface WatchdogDeps {
  /** The lease directory. */
  dir: string;
  scan: () => string;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface State {
  stoppedSince: Record<string, number>;
  /** Keys of `once` findings already emitted. */
  reported: string[];
  /** The latest cycle's emitted findings. */
  findings: Finding[];
}

/** `ps` `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for any other shape. */
export function parseElapsed(etime: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  return m ? (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : NaN;
}

function parseTable(text: string): Proc[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], elapsedMs: parseElapsed(m[5]), command: m[6] }] : [];
  });
}

/** Whether `row` can be the process that wrote a record started at `startedAt`: one that started later holds a reused pid. An unreadable time on either side keeps the row. */
function isSameProcess(row: Proc, startedAt: unknown, now: number): boolean {
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  return !(now - row.elapsedMs > started + START_SLACK_MS);
}

/** The `*.json` files of `<dir>/<sub>` (a temp file of `writeFileAtomic` ends in `.tmp`), parsed; one that is gone or unparsable is skipped. */
function readRecords(dir: string, sub: string): { name: string; record: any; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, sub)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const file = join(dir, sub, name);
      return [{ name, record: JSON.parse(readFileSync(file, "utf-8")), mtimeMs: statSync(file).mtimeMs }];
    } catch {
      return [];
    }
  });
}

function readEngines(dir: string, now: number, procs: Proc[]): Engine[] {
  return readRecords(dir, "engines").flatMap(({ record: r, mtimeMs }) => {
    if (!isPid(r?.pid) || typeof r.runId !== "string") return [];
    const row = procs.find((p) => p.pid === r.pid);
    // A null pgid (ps failed at engine start) falls back to the scan's.
    return [{ ...r, pgid: Number.isInteger(r.pgid) ? r.pgid : (row?.pgid ?? null), fresh: isWithinWindow(mtimeMs, now, ENGINE_FRESH_MS), alive: row !== undefined && isSameProcess(row, r.startedAt, now), mtimeMs, stopped: row?.stat.startsWith("T") ?? false, stallTimeout: Number.isFinite(r.stallTimeout) && r.stallTimeout >= 0 ? r.stallTimeout : 0 }];
  });
}

/** Groups whose every member is stopped (`stat` starts with `T`) and that contain or descend from a `claude` process, or belong to a live registered engine. */
function stoppedGroups(procs: Proc[], engines: Engine[]): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isClaude = (p: Proc): boolean => /(^|[\s/])claude(\s|$)/.test(p.command);
  const underClaude = (p: Proc): boolean => {
    for (let cur: Proc | undefined = p, n = 0; cur && n < 64; cur = byPid.get(cur.ppid), n++) if (isClaude(cur)) return true;
    return false;
  };
  const enginePgids = new Set(engines.filter((e) => e.alive).map((e) => e.pgid));
  const groups = new Map<number, Proc[]>();
  for (const p of procs) groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
  return [...groups].filter(([pgid, members]) => members.every((p) => p.stat.startsWith("T")) && (enginePgids.has(pgid) || members.some(underClaude))).map(([pgid]) => pgid);
}

function readState(dir: string): State {
  try {
    const s = JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf-8"));
    return { stoppedSince: s.stoppedSince ?? {}, reported: s.reported ?? [], findings: s.findings ?? [] };
  } catch {
    return { stoppedSince: {}, reported: [], findings: [] };
  }
}

/** Appends one line to `watchdog.log`; only a regular file is appended to, and a new one has mode 0600. A failure is swallowed: the log is a diagnostic. */
function appendLog(dir: string, now: number, text: string): void {
  try {
    const fd = openSync(join(dir, "watchdog.log"), LOG_FLAGS, 0o600);
    try {
      if (fstatSync(fd).isFile()) appendFileSync(fd, `${new Date(now).toISOString()} ${text}\n`);
    } finally {
      closeSync(fd);
    }
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
  let procs: Proc[];
  try {
    procs = parseTable(d.scan());
    if (procs.length === 0) throw new Error("empty process table");
  } catch (err) {
    appendLog(d.dir, now, `scan skipped: ${(err as Error).message}`);
    return;
  }
  const engines = readEngines(d.dir, now, procs);
  const stoppedSince = new Map(stoppedGroups(procs, engines).map((pgid) => [pgid, prev.stoppedSince[pgid] ?? now]));
  const suspended = new Set(readSuspensions(d.dir).map((r) => r.pgid));
  const found = RULES.flatMap((rule) => rule({ now, procs, engines, suspended, stoppedSince }));
  const findings = found.filter((f) => !(f.once && prev.reported.includes(f.key)));
  const state: State = { stoppedSince: Object.fromEntries(stoppedSince), reported: found.filter((f) => f.once).map((f) => f.key), findings };
  writeLeaseRecord(d.dir, "watchdog.json", JSON.stringify({ checkedAt: new Date(now).toISOString(), ...state }));
  writeLeaseRecord(d.dir, "watchdog.brief", findings.length ? `watchdog: ${findings.map((f) => f.message).join("; ")}` : "");
  for (const f of findings) if (!prev.findings.some((p) => p.key === f.key)) appendLog(d.dir, now, f.message);
}

/** Runs `check` or `brief` (`argv[0]`): exit 0 done, 64 usage. `brief` prints `watchdog.brief`, and nothing when it is empty or missing. */
export function runWatchdog(argv: string[], d: WatchdogDeps): number {
  if (argv.length !== 1 || (argv[0] !== "check" && argv[0] !== "brief")) {
    d.err(USAGE);
    return EX_USAGE;
  }
  if (argv[0] === "check") check(d);
  else {
    let line = "";
    try {
      line = readFileSync(join(d.dir, "watchdog.brief"), "utf-8");
    } catch {}
    if (line) d.out(line);
  }
  return 0;
}
