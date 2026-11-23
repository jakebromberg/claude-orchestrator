/**
 * `heavy-queue watch`: a live, full-screen view of the machine-wide lease that redraws every interval until SIGINT or SIGTERM.
 * It reads the same view `status` prints (`statusView`) and never takes the lease's mutex or writes a ticket.
 */
import type { StatusView } from "./lease-run.js";
export interface WatchArgs {
    kind: "watch";
    /** Seconds between redraws; always finite and above 0. */
    intervalSec: number;
}
export interface RenderOptions {
    now: Date;
    /** Columns available; every line is cut to it. */
    width: number;
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
    /** When false, frames are written plain, one after another, with no escape codes. */
    isTTY: boolean;
    columns(): number;
    signals: {
        once(sig: NodeJS.Signals, fn: () => void): unknown;
        off(sig: NodeJS.Signals, fn: () => void): unknown;
    };
    timeZone?: string;
}
/** Draws one frame of the queue, or the read error in place of the tables. */
export declare function renderQueue(view: StatusView | Error, o: RenderOptions): string;
/** Redraws the queue every `intervalSec` until SIGINT or SIGTERM, then restores the screen and resolves 0. */
export declare function runWatch(args: Pick<WatchArgs, "intervalSec">, d: WatchDeps): Promise<number>;
