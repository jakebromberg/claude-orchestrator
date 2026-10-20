/**
 * The memory the lease does not own, for `claude-orchestrator-lease status`: booted simulators, `claude` processes that are not a lease-owned session's
 * child, and the largest other processes. Report only, never on the admission path. It comes from its own bounded `ps` call (rss in KiB), cached a few
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
const SIMULATOR = /\/CoreSimulator\/Devices\//;
/** Groups `ps` output (`UNOWNED_PS_ARGS`); `sessionPids` are the pids of the live session holders, whose direct `claude` children are lease-owned. */
export function summarizeUnowned(text, sessionPids) {
    const owners = new Set(sessionPids);
    const out = { simulators: 0, claude: 0, others: [] };
    for (const line of text.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m)
            continue;
        const [pid, ppid, bytes, command] = [Number(m[1]), Number(m[2]), Number(m[3]) * 1024, m[4]];
        if (SIMULATOR.test(command))
            out.simulators += bytes;
        else if (basename(command.split(/\s/)[0]) === "claude")
            out.claude += owners.has(ppid) ? 0 : bytes;
        else if (bytes >= OTHER_MIN_BYTES)
            out.others.push({ pid, command, bytes });
    }
    out.others = out.others.sort((a, b) => b.bytes - a.bytes).slice(0, OTHER_MAX);
    return out;
}
const valid = (r) => Number.isFinite(r?.at) && Number.isFinite(r.simulators) && Number.isFinite(r.claude) && Array.isArray(r.others);
/** The cached sample while it is under `UNOWNED_CACHE_MS` old, else a fresh one (cached best effort); `undefined` when `ps` fails. */
export function sampleUnowned(deps, sessionPids) {
    const now = (deps.now ?? Date.now)();
    try {
        const cached = JSON.parse(readLeaseRecord(deps.dir, "unowned.json")?.text ?? "null");
        if (valid(cached) && isFresh(cached.at, now, UNOWNED_CACHE_MS))
            return { simulators: cached.simulators, claude: cached.claude, others: cached.others };
    }
    catch {
        // An unreadable cache is a miss.
    }
    try {
        const sample = summarizeUnowned((deps.ps ?? ((a) => ps(a, { timeoutMs: 2_000 })))(UNOWNED_PS_ARGS), sessionPids);
        try {
            writeLeaseRecord(deps.dir, "unowned.json", JSON.stringify({ at: now, ...sample }));
        }
        catch {
            // The cache is an optimisation.
        }
        return sample;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=unowned-memory.js.map