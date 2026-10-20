/**
 * The memory the lease does not own, for `claude-orchestrator-lease status`: booted simulators, `claude` processes that are not a lease-owned session's
 * child, and the largest other processes that a heavy holder does not own. Report only, never on the admission path. It comes from the shared bounded process-table scan, cached a few
 * seconds in `<lease dir>/unowned.json` through the lease-record reader and writer, and a failed sample is `undefined` so `status` goes on without it.
 */

import { isFresh } from "./memory-pressure.js";
import { readLeaseRecord, writeLeaseRecord } from "./lease-dir.js";
import { ancestry, isClaudeCommand, isSimulatorCommand, parsePsTable, ps, PS_TABLE_ARGS, type ProcRow } from "./ps.js";

export const UNOWNED_CACHE_MS = 5_000;
/** A process below this many bytes is not listed among the others. */
const OTHER_MIN_BYTES = 500 * 2 ** 20;
const OTHER_MAX = 5;

/** Bytes by group; `claude` leaves out the sessions a live session holder started, `others` is the largest remaining processes above the threshold. */
export interface UnownedMemory {
  simulators: number;
  claude: number;
  others: { pid: number; command: string; bytes: number }[];
}

/**
 * Groups the rows of the shared process-table scan (`PS_TABLE_ARGS`); `sessionPids` are the pids of the live session holders, whose direct `claude` children are lease-owned,
 * and `leasedRoots` the processes heavy holders own (a recorded child pid, or a hook holder's session pid), whose descendants are left out of `others`.
 */
export function summarizeUnowned(rows: ProcRow[], sessionPids: number[], leasedRoots: number[] = []): UnownedMemory {
  const owners = new Set(sessionPids);
  const roots = new Set(leasedRoots);
  const out: UnownedMemory = { simulators: 0, claude: 0, others: [] };
  for (const { pid, ppid, rssBytes: bytes, command } of rows) {
    if (Number.isNaN(bytes)) continue;
    if (isSimulatorCommand(command)) out.simulators += bytes;
    else if (isClaudeCommand(command)) out.claude += owners.has(ppid) ? 0 : bytes;
    else if (bytes >= OTHER_MIN_BYTES && !ancestry(rows, pid, 64).chain.some((r) => roots.has(r.pid))) out.others.push({ pid, command, bytes });
  }
  out.others = out.others.sort((a, b) => b.bytes - a.bytes).slice(0, OTHER_MAX);
  return out;
}

const validOther = (o: any): boolean => Number.isFinite(o?.pid) && typeof o.command === "string" && Number.isFinite(o.bytes);
const valid = (r: any): r is UnownedMemory & { at: number; key: string } =>
  Number.isFinite(r?.at) && typeof r.key === "string" && Number.isFinite(r.simulators) && Number.isFinite(r.claude) && Array.isArray(r.others) && r.others.every(validOther);

/** The cached sample while it is under `UNOWNED_CACHE_MS` old and was grouped for the same holder pids, else a fresh one (cached best effort); `undefined` when `ps` fails. */
export function sampleUnowned(
  deps: { dir: string; now?(): number; ps?(args: string[]): string },
  sessionPids: number[],
  leasedRoots: number[] = [],
): UnownedMemory | undefined {
  const now = (deps.now ?? Date.now)();
  const key = JSON.stringify([sessionPids, leasedRoots]);
  try {
    const cached = JSON.parse(readLeaseRecord(deps.dir, "unowned.json")?.text ?? "null");
    if (valid(cached) && cached.key === key && isFresh(cached.at, now, UNOWNED_CACHE_MS)) return { simulators: cached.simulators, claude: cached.claude, others: cached.others };
  } catch {
    // An unreadable cache is a miss.
  }
  try {
    const sample = summarizeUnowned(parsePsTable((deps.ps ?? ((a) => ps(a)))(PS_TABLE_ARGS)), sessionPids, leasedRoots);
    try {
      writeLeaseRecord(deps.dir, "unowned.json", JSON.stringify({ at: now, key, ...sample }));
    } catch {
      // The cache is an optimisation.
    }
    return sample;
  } catch {
    return undefined;
  }
}
