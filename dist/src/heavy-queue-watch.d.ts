/**
 * `heavy-queue watch`: a live, full-screen view of the machine-wide lease that redraws every interval until SIGINT or SIGTERM.
 * It reads the same view `status` prints (`statusView`) and takes no mutex, ticket or holder; like `status`, a read may refresh the shared pressure reading and the unowned-memory cache when they are stale.
 */
import type { StatusView } from "./lease-run.js";
export interface WatchArgs {
    kind: "watch";
    /** Seconds between redraws; always finite and above 0. */
    intervalSec: number;
}
/** Redraws come no faster than this, so a watch never spins. */
export declare const MIN_WATCH_INTERVAL_SEC = 0.1;
/** The longest interval a Node timer holds; past it Node fires every 1 ms. */
export declare const MAX_WATCH_INTERVAL_SEC: number;
export interface RenderOptions {
    now: Date;
    /** Columns available; every line is cut to it. */
    width: number;
    /** Rows available; a taller frame is cut to it, its last row saying how many lines are hidden. Absent, no limit. */
    height?: number;
    /** Lease warnings, each shown under the header. */
    notes?: readonly string[];
    /** IANA zone for the header clock; absent, the process's own. */
    timeZone?: string;
}
/** What `runWatch` needs from the process, injectable for tests. */
export interface WatchDeps {
    /** Reads the lease; a throw is drawn as `status unavailable` and the watch goes on. */
    status(): StatusView;
    now(): Date;
    /** Calls `fn` every `ms` until the returned function is called. */
    every(fn: () => void, ms: number): () => void;
    write(text: string): void;
    /** When false, frames are written plain and whole, one after another, with no escape codes. */
    isTTY: boolean;
    columns(): number;
    rows(): number;
    /** The lease warnings collected so far, each once. */
    notes(): readonly string[];
    /** Calls `fn` once when the watch should end (Ctrl-C, SIGTERM, a closed output); returns the unsubscribe. */
    onStop(fn: () => void): () => void;
    timeZone?: string;
}
/** Draws one frame of the queue, or the read error in place of the tables. */
export declare function renderQueue(view: StatusView | Error, o: RenderOptions): string;
/** Redraws the queue every `intervalSec` until `onStop` fires, then restores the screen and resolves 0. A terminal frame is cut one column short of the width (so the last column never wraps) and to the rows; a plain frame is whole. */
export declare function runWatch(args: Pick<WatchArgs, "intervalSec">, d: WatchDeps): Promise<number>;
