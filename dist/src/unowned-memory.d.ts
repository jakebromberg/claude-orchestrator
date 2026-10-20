/**
 * The memory the lease does not own, for `claude-orchestrator-lease status`: booted simulators, `claude` processes that are not a lease-owned session's
 * child, and the largest other processes. Report only, never on the admission path. It comes from its own bounded `ps` call (rss in KiB), cached a few
 * seconds in `<lease dir>/unowned.json` through the lease-record reader and writer, and a failed sample is `undefined` so `status` goes on without it.
 */
export declare const UNOWNED_PS_ARGS: string[];
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
/** Groups `ps` output (`UNOWNED_PS_ARGS`); `sessionPids` are the pids of the live session holders, whose direct `claude` children are lease-owned. */
export declare function summarizeUnowned(text: string, sessionPids: number[]): UnownedMemory;
/** The cached sample while it is under `UNOWNED_CACHE_MS` old, else a fresh one (cached best effort); `undefined` when `ps` fails. */
export declare function sampleUnowned(deps: {
    dir: string;
    now?(): number;
    ps?(args: string[]): string;
}, sessionPids: number[]): UnownedMemory | undefined;
