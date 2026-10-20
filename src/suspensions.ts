import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { ensureOwnSubdir, readRecordDir } from "./lease-dir.js";
import { leaseDirectory } from "./memory-pressure.js";
import { ancestry, isPid, parsePsTable, ps, PS_TABLE_ARGS, signalGroup, type ProcRow } from "./ps.js";

const EX_USAGE = 64;
const EX_CONFIG = 78;
/** The longest `--remind`: 30 days. */
const MAX_REMIND_MS = 30 * 24 * 3_600_000;
/** How far the ancestry walk climbs before it gives up and refuses. */
const MAX_ANCESTRY = 64;
const USAGE = "usage: claude-orchestrator-lease suspend <pgid> --by <who> --reason <why> [--remind <n>m|<n>h] [--record-only] | resume <pgid>";

export type SuspensionArgs =
  | { kind: "suspend"; raw: string; pgid: number; by: string; reason: string; remindMs: number; recordOnly: boolean }
  | { kind: "resume"; raw: string; pgid: number };

/** Everything `runSuspension` touches outside the process: tests inject all of it, so nothing is signalled that the test did not spawn. */
export interface SuspensionDeps {
  /** The lease directory; records live in `<dir>/suspensions/<pgid>.json`. */
  dir: string;
  ps: (args: string[]) => string;
  /** Signals a process group (a negative pid). */
  kill: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  now: () => number;
  /** This process; it and every ancestor up to pid 1 must appear in the `ps` scan, or the command refuses. */
  pid: number;
  /** Undefined on a platform without uids, which skips the ownership check. */
  uid: number | undefined;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Parses `suspend <pgid> --by --reason [--remind] [--record-only]` or `resume <pgid>`; throws a usage error. A pgid that is not a number parses to NaN, which `runSuspension` refuses. */
export function parseSuspensionArgs(argv: string[]): SuspensionArgs {
  const [verb, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let recordOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (verb === "suspend" && a === "--record-only") recordOnly = true;
    else if (verb === "suspend" && (a === "--by" || a === "--reason" || a === "--remind")) {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      flags[a] = value;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error("expected exactly one process group id");
  const raw = positional[0];
  const pgid = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (verb === "resume") return { kind: "resume", raw, pgid };
  if (!flags["--by"] || !flags["--reason"]) throw new Error("suspend needs --by and --reason");
  const remind = /^([1-9]\d*)([mh])$/.exec(flags["--remind"] ?? "2h");
  const remindMs = remind ? Number(remind[1]) * (remind[2] === "h" ? 3_600_000 : 60_000) : NaN;
  if (!(remindMs <= MAX_REMIND_MS)) throw new Error(`--remind takes a positive integer with an m or h unit, at most 720h, got ${JSON.stringify(flags["--remind"])}`);
  return { kind: "suspend", raw, pgid, by: flags["--by"], reason: flags["--reason"], remindMs, recordOnly };
}

/** The groups of this process and every ancestor, walked through the scan itself. Fails closed: a link missing from the scan, or a chain that never reaches pid 1, refuses rather than guarding a partial list. */
function guardedGroups(table: ProcRow[], d: SuspensionDeps): number[] {
  const { chain, complete } = ancestry(table, d.pid, MAX_ANCESTRY);
  if (!complete) throw new Error(`cannot read this command's whole ancestry (stopped at pid ${chain.at(-1)?.ppid ?? d.pid}); refusing`);
  return chain.map((r) => r.pgid);
}

/** Throws unless `args.pgid` is a group this tool may touch, and returns its live members. */
function checkGroup(args: SuspensionArgs, d: SuspensionDeps): ProcRow[] {
  if (!isPid(args.pgid) || args.pgid === 1) throw new Error(`${args.raw} is not a process group this tool will touch`);
  // One bounded scan: group membership, liveness, ownership and leader command all come from it.
  const table = parsePsTable(d.ps(PS_TABLE_ARGS));
  if (guardedGroups(table, d).includes(args.pgid)) throw new Error(`process group ${args.pgid} is this command's own or an ancestor's`);
  const members = table.filter((m) => m.pgid === args.pgid);
  if (d.uid !== undefined && members.some((m) => m.uid !== d.uid)) throw new Error(`process group ${args.pgid} has a member owned by another user`);
  return members;
}

/** What `suspend` records for a process group, in `<lease dir>/suspensions/<pgid>.json`. `at` and `remindAt` are ISO timestamps; `leader` is the command of the member whose pid is the pgid, or `null` when it has exited. */
export interface SuspensionRecord {
  pgid: number;
  by: string;
  reason: string;
  at: string;
  remindAt: string;
  leader: string | null;
}

/** The record file of a process group: the one place that names the `suspensions/` path. */
export function suspensionFile(dir: string, pgid: number): string {
  return join(dir, "suspensions", `${pgid}.json`);
}

/** Writes `record` through the lease's directory rule; throws when the group already has one. The complete temp file is hard-linked to the final name, so the refusal is atomic (`EEXIST`) and a reader never sees a partial record. */
export function writeSuspension(dir: string, record: SuspensionRecord): void {
  ensureOwnSubdir(dir, "suspensions");
  const file = suspensionFile(dir, record.pgid);
  try {
    writeFileAtomic(file, JSON.stringify(record), { exclusive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`process group ${record.pgid} already has a suspension record (${file})`);
    throw err;
  }
}

/** Removes the record of `pgid`; returns whether one existed. */
export function removeSuspension(dir: string, pgid: number): boolean {
  ensureOwnSubdir(dir, "suspensions");
  const file = suspensionFile(dir, pgid);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}

/** The valid records in `<dir>/suspensions` (`readRecordDir`'s name and directory rule): an unreadable or invalid body (`at` and `remindAt` must parse as dates), or a body whose pgid is not its name, is skipped. */
export function readSuspensions(dir: string): SuspensionRecord[] {
  return readRecordDir(dir, "suspensions").flatMap(({ stem, text }) => {
    try {
      const r = JSON.parse(text);
      const isDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
      const ok = r?.pgid === stem && typeof r.by === "string" && typeof r.reason === "string" && isDate(r.at) && isDate(r.remindAt) && (r.leader === null || typeof r.leader === "string");
      return ok ? [{ pgid: r.pgid, by: r.by, reason: r.reason, at: r.at, remindAt: r.remindAt, leader: r.leader }] : [];
    } catch {
      return [];
    }
  });
}

/** Runs `suspend` or `resume` (`argv[0]`): exit 0 done, 1 refused or failed, 64 usage. A suspend writes the record before the signal; a resume signals before it removes the record. */
export function runSuspension(argv: string[], d: SuspensionDeps): number {
  let args: SuspensionArgs;
  try {
    args = parseSuspensionArgs(argv);
  } catch (err) {
    d.err(`lease: ${(err as Error).message}\n${USAGE}`);
    return EX_USAGE;
  }
  try {
    const members = checkGroup(args, d);
    ensureOwnSubdir(d.dir, "suspensions");
    const file = suspensionFile(d.dir, args.pgid);
    if (args.kind === "resume") {
      // A group that is gone has nothing to continue; its record can still go.
      signalGroup(args.pgid, "SIGCONT", d.kill);
      const had = removeSuspension(d.dir, args.pgid);
      d.out(`lease: resumed process group ${args.pgid}${had ? `; removed ${file}` : "; no record existed"}`);
      return 0;
    }
    if (members.length === 0) throw new Error(`process group ${args.pgid} has no live members`);
    const at = d.now();
    const leader = members.find((m) => m.pid === args.pgid)?.command ?? null;
    writeSuspension(d.dir, { pgid: args.pgid, by: args.by, reason: args.reason, at: new Date(at).toISOString(), remindAt: new Date(at + args.remindMs).toISOString(), leader });
    if (!args.recordOnly) {
      try {
        // The group vanished since the scan: report it as the signal call would have.
        if (!signalGroup(args.pgid, "SIGSTOP", d.kill)) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      } catch (err) {
        removeSuspension(d.dir, args.pgid);
        throw err;
      }
    }
    d.out(`lease: ${args.recordOnly ? "recorded" : "suspended"} process group ${args.pgid} (${file})`);
    return 0;
  } catch (err) {
    d.err(`lease: ${(err as Error).message}`);
    return 1;
  }
}

/** The entry point `cli-lease.ts` dispatches `suspend` and `resume` to: real `ps`, signals and clock, the lease directory from the environment (exit 78 when it is misconfigured). */
export function runSuspensionCli(argv: string[]): number {
  const err = (line: string): void => void process.stderr.write(`${line}\n`);
  let dir: string;
  try {
    dir = leaseDirectory(process.env);
  } catch (e) {
    err(`lease: ${(e as Error).message}`);
    return EX_CONFIG;
  }
  return runSuspension(argv, {
    dir,
    ps,
    kill: (pid, signal) => void process.kill(pid, signal),
    now: Date.now,
    pid: process.pid,
    uid: process.getuid?.(),
    out: (line) => void process.stdout.write(`${line}\n`),
    err,
  });
}
