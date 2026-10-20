/**
 * The memory the lease does not own, for `claude-orchestrator-lease status`: booted simulators, `claude` processes that are not a lease-owned session's
 * child, and the largest other processes that a heavy holder does not own. Report only, never on the admission path. It comes from the shared bounded process-table scan, cached a few
 * seconds in `<lease dir>/unowned.json` through the lease-record reader and writer, and a failed sample is `undefined` so `status` goes on without it.
 */
import { type ProcRow } from "./ps.js";
export declare const UNOWNED_CACHE_MS = 5000;
/** Bytes by group; `claude` leaves out the sessions a live session holder started, `others` is the largest remaining processes above the threshold. */
export interface UnownedMemory {
    simulators: number;
    claude: number;
    others: {
        pid: number;
        command: string;
        bytes: number;
    }[];
}
/**
 * Groups the rows of the shared process-table scan (`PS_TABLE_ARGS`); `sessionPids` are the pids of the live session holders, whose direct `claude` children are lease-owned,
 * and `leasedRoots` the processes heavy holders own (a recorded child pid, or a hook holder's session pid), whose descendants are left out of `others`.
 */
export declare function summarizeUnowned(rows: ProcRow[], sessionPids: number[], leasedRoots?: number[]): UnownedMemory;
/** The cached sample while it is under `UNOWNED_CACHE_MS` old and was grouped for the same holder pids, else a fresh one (cached best effort); `undefined` when `ps` fails. */
export declare function sampleUnowned(deps: {
    dir: string;
    now?(): number;
    ps?(args: string[]): string;
}, sessionPids: number[], leasedRoots?: number[]): UnownedMemory | undefined;
