import { execFileSync } from "node:child_process";

/** Runs `ps` and returns trimmed stdout; throws on failure. Bounded (2 s unless `timeoutMs`) and stderr is discarded, so a hung `ps` cannot stall a caller and nothing writes past a `warn` seam. */
export function ps(args: string[], { timeoutMs = 2_000 }: { timeoutMs?: number } = {}): string {
  return execFileSync("ps", args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** One `ps -o <field>= -p <pid>` value; throws on failure. */
export const psField = (pid: number, field: string, opts?: { timeoutMs?: number }): string => ps(["-o", `${field}=`, "-p", String(pid)], opts);

/** `startPid` and its parents, nearest first, at most `depth` entries; stops at pid 1 and any failure ends the walk with what it has found. */
export function psAncestors(startPid: number, depth: number): number[] {
  const found: number[] = [];
  try {
    for (let pid = startPid; found.length < depth && Number.isInteger(pid) && pid > 1; pid = Number(psField(pid, "ppid"))) {
      found.push(pid);
    }
  } catch {
    // A failed lookup ends the walk, never an error.
  }
  return found;
}

/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process, and `process.kill` rejects 2^31 and above. */
export const isPid = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0 && (n as number) < 2 ** 31;

/** Whether `kill(pid, 0)` finds the process: it exists, or exists under another user (`EPERM`). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps` `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for any other shape. */
export function parseElapsed(etime: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  return m ? (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : NaN;
}

/** The one process-table scan: `ps` arguments whose output `parsePsTable` reads. Callers keep their own `ps` (and timeout), so injected dependencies stay text-in. */
export const PS_TABLE_ARGS = ["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,command="];

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** `ps` `stat`: state letter first, then flags. */
  stat: string;
  /** Time since the process started (`etime`), or NaN when the column cannot be read. */
  elapsedMs: number;
  command: string;
}

/** The rows of `PS_TABLE_ARGS` output; a line that is not a row is skipped. */
export function parsePsTable(text: string): ProcRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), stat: m[5], elapsedMs: parseElapsed(m[6]), command: m[7] }] : [];
  });
}

/** `pid` and its parents through `rows`, nearest first, without pid 1. `complete` is false when a link is missing from the scan or the chain is not finished within `max` rows (a loop), so a caller that guards on the chain can fail closed. */
export function ancestry(rows: ProcRow[], pid: number, max: number): { chain: ProcRow[]; complete: boolean } {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain: ProcRow[] = [];
  while (pid > 1) {
    const row = byPid.get(pid);
    if (!row || chain.length >= max) return { chain, complete: false };
    chain.push(row);
    pid = row.ppid;
  }
  return { chain, complete: true };
}
