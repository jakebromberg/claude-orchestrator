/**
 * The memory the lease does not own, for `claude-orchestrator-lease status`: booted simulators, `claude` processes that are not a lease-owned session's
 * child, and the largest other processes that are not a heavy holder's recorded command. Report only, never on the admission path. It comes from its own bounded `ps` call (rss in KiB), cached a few
 * seconds in `<lease dir>/unowned.json` through the lease-record reader and writer, and a failed sample is `undefined` so `status` goes on without it.
 */

import { basename } from "node:path";
import { isFresh } from "./memory-pressure.js";
import { readLeaseRecord, writeLeaseRecord } from "./lease-dir.js";
import { ps } from "./ps.js";

export const UNOWNED_PS_ARGS = ["-axo", "pid=,ppid=,rss=,command="];
export const UNOWNED_CACHE_MS = 5_000;
/** A process below this many bytes is not listed among the others. */
const OTHER_MIN_BYTES = 500 * 2 ** 20;
const OTHER_MAX = 5;
/** A device's own files (`CoreSimulator/Devices/<udid>/...`) or a runtime's processes (`CoreSimulator/Volumes/...` or any `.simruntime/` root). */
const SIMULATOR = /\/CoreSimulator\/(Devices|Volumes)\/|\.simruntime\//;

/** Bytes by group; `claude` leaves out the sessions a live session holder started, `others` is the largest remaining processes above the threshold. */
export interface UnownedMemory {
  simulators: number;
  claude: number;
  others: { pid: number; command: string; bytes: number }[];
}

/**
 * Groups `ps` output (`UNOWNED_PS_ARGS`); `sessionPids` are the pids of the live session holders, whose direct `claude` children are lease-owned,
 * and `heavyChildPids` the commands that heavy holders recorded, which with their descendants are left out of `others`.
 */
export function summarizeUnowned(text: string, sessionPids: number[], heavyChildPids: number[] = []): UnownedMemory {
  const owners = new Set(sessionPids);
  const rows = text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * 1024, command: m[4]! }] : [];
  });
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const leased = new Set(heavyChildPids);
  const isLeased = (pid: number): boolean => {
    for (let p: number | undefined = pid, n = 0; p !== undefined && p > 1 && n < 64; p = parent.get(p), n++) if (leased.has(p)) return true;
    return false;
  };
  const out: UnownedMemory = { simulators: 0, claude: 0, others: [] };
  for (const { pid, ppid, bytes, command } of rows) {
    if (SIMULATOR.test(command)) out.simulators += bytes;
    else if (basename(command.split(/\s/)[0]!) === "claude") out.claude += owners.has(ppid) ? 0 : bytes;
    else if (bytes >= OTHER_MIN_BYTES && !isLeased(pid)) out.others.push({ pid, command, bytes });
  }
  out.others = out.others.sort((a, b) => b.bytes - a.bytes).slice(0, OTHER_MAX);
  return out;
}

const valid = (r: any): r is UnownedMemory & { at: number } =>
  Number.isFinite(r?.at) && Number.isFinite(r.simulators) && Number.isFinite(r.claude) && Array.isArray(r.others);

/** The cached sample while it is under `UNOWNED_CACHE_MS` old, else a fresh one (cached best effort); `undefined` when `ps` fails. */
export function sampleUnowned(
  deps: { dir: string; now?(): number; ps?(args: string[]): string },
  sessionPids: number[],
  heavyChildPids: number[] = [],
): UnownedMemory | undefined {
  const now = (deps.now ?? Date.now)();
  try {
    const cached = JSON.parse(readLeaseRecord(deps.dir, "unowned.json")?.text ?? "null");
    if (valid(cached) && isFresh(cached.at, now, UNOWNED_CACHE_MS)) return { simulators: cached.simulators, claude: cached.claude, others: cached.others };
  } catch {
    // An unreadable cache is a miss.
  }
  try {
    const sample = summarizeUnowned((deps.ps ?? ((a) => ps(a, { timeoutMs: 2_000 })))(UNOWNED_PS_ARGS), sessionPids, heavyChildPids);
    try {
      writeLeaseRecord(deps.dir, "unowned.json", JSON.stringify({ at: now, ...sample }));
    } catch {
      // The cache is an optimisation.
    }
    return sample;
  } catch {
    return undefined;
  }
}
