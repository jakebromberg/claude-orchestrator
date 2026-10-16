import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { ensureOwnSubdir, isPid } from "./lease.js";
import { leaseDirectory } from "./memory-pressure.js";
import { ps } from "./ps.js";

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

interface Member {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  command: string;
}

/** One bounded scan of the process table: group membership, liveness, ownership and leader command all come from it. */
function readTable(d: SuspensionDeps): Member[] {
  return d.ps(["-axo", "pid=,ppid=,pgid=,uid=,command="]).split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), command: m[5] }] : [];
  });
}

/** The groups of this process and every ancestor, walked through the scan itself. Fails closed: a link missing from the scan, or a chain that never reaches pid 1, refuses rather than guarding a partial list. */
function guardedGroups(table: Member[], d: SuspensionDeps): number[] {
  const byPid = new Map(table.map((m) => [m.pid, m]));
  const groups: number[] = [];
  for (let pid = d.pid; pid > 1; ) {
    const m = byPid.get(pid);
    if (!m || groups.length >= MAX_ANCESTRY) throw new Error(`cannot read this command's whole ancestry (stopped at pid ${pid}); refusing`);
    groups.push(m.pgid);
    pid = m.ppid;
  }
  return groups;
}

/** Throws unless `args.pgid` is a group this tool may touch, and returns its live members. */
function checkGroup(args: SuspensionArgs, d: SuspensionDeps): Member[] {
  if (!isPid(args.pgid) || args.pgid === 1) throw new Error(`${args.raw} is not a process group this tool will touch`);
  const table = readTable(d);
  if (guardedGroups(table, d).includes(args.pgid)) throw new Error(`process group ${args.pgid} is this command's own or an ancestor's`);
  const members = table.filter((m) => m.pgid === args.pgid);
  if (d.uid !== undefined && members.some((m) => m.uid !== d.uid)) throw new Error(`process group ${args.pgid} has a member owned by another user`);
  return members;
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
    const file = join(d.dir, "suspensions", `${args.pgid}.json`);
    if (args.kind === "resume") {
      try {
        d.kill(-args.pgid, "SIGCONT");
      } catch (err) {
        // A group that is gone has nothing to continue; its record can still go.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      const had = existsSync(file);
      rmSync(file, { force: true });
      d.out(`lease: resumed process group ${args.pgid}${had ? `; removed ${file}` : "; no record existed"}`);
      return 0;
    }
    if (members.length === 0) throw new Error(`process group ${args.pgid} has no live members`);
    if (existsSync(file)) throw new Error(`process group ${args.pgid} already has a suspension record (${file})`);
    const at = d.now();
    const leader = members.find((m) => m.pid === args.pgid)?.command ?? null;
    writeFileAtomic(file, JSON.stringify({ pgid: args.pgid, by: args.by, reason: args.reason, at: new Date(at).toISOString(), remindAt: new Date(at + args.remindMs).toISOString(), leader }));
    if (!args.recordOnly) {
      try {
        d.kill(-args.pgid, "SIGSTOP");
      } catch (err) {
        rmSync(file, { force: true });
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
