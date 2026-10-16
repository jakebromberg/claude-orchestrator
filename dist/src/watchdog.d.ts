/** A stopped group with no suspension record is reported this long after it was first seen stopped. */
export declare const STOPPED_AFTER_MS: number;
/** An engine record is fresh for three refresh periods, the lease's heartbeat rule. */
export declare const ENGINE_FRESH_MS: number;
/** A stale engine record whose pid is alive and running is reported once it is older than the engine's `stallTimeout` plus this. */
export declare const STALLED_MARGIN_MS: number;
export interface Proc {
    pid: number;
    ppid: number;
    pgid: number;
    stat: string;
    /** Time since the process started (`ps` `etime`), or NaN when the column cannot be read. */
    elapsedMs: number;
    command: string;
}
/** An `engines/<pid>.json` record (see `engine-registry.ts`) with the verdicts the rules need. */
export interface Engine {
    pid: number;
    pgid: number | null;
    runId: string;
    logDir: string;
    stallTimeout: number;
    startedAt: string;
    /** The record's mtime is within `ENGINE_FRESH_MS` of the clock. */
    fresh: boolean;
    /** The pid has a row in the scan, for a process that started no later than the record's `startedAt` (a later one holds a reused pid). */
    alive: boolean;
    /** The record's mtime: how long ago the engine last refreshed it. */
    mtimeMs: number;
    /** The engine's own scan row has a `stat` starting with `T`. */
    stopped: boolean;
}
/** One thing to tell the owner. `once` findings are emitted in one cycle per `key` while the thing they describe lasts. */
export interface Finding {
    key: string;
    message: string;
    once?: boolean;
}
/** What a rule sees: the scan, the registry and the suspension records, all read once per cycle. */
export interface Context {
    now: number;
    procs: Proc[];
    engines: Engine[];
    /** Groups with a `suspensions/<pgid>.json` record. */
    suspended: Set<number>;
    /** In-scope stopped groups, with the time each was first seen stopped. */
    stoppedSince: Map<number, number>;
}
export type Rule = (c: Context) => Finding[];
/** The rules, in report order. A rule reads the context and returns findings; the reporters never change. */
export declare const RULES: Rule[];
/** The default scan: one bounded `ps`, 60 s because it can be slow at background priority. A throw skips the cycle. */
export declare const scanProcessTable: () => string;
export interface WatchdogDeps {
    /** The lease directory. */
    dir: string;
    scan: () => string;
    now: () => number;
    out: (line: string) => void;
    err: (line: string) => void;
}
/** `ps` `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for any other shape. */
export declare function parseElapsed(etime: string): number;
/**
 * One cycle: scan, run every rule, then write `watchdog.json`, `watchdog.brief` (the one-line summary, empty when all
 * is well) and `watchdog.log` (each newly emitted finding). Writes nothing unless the lease directory passes the
 * lease's directory rule, and never creates it. A scan that throws or returns no rows skips the cycle: the previous
 * state stays and the skip is logged. A dead engine's record is reported once per `runId` and never deleted.
 */
export declare function check(d: WatchdogDeps): void;
/** Runs `check` or `brief` (`argv[0]`): exit 0 done, 64 usage. `brief` prints `watchdog.brief`, and nothing when it is empty or missing. */
export declare function runWatchdog(argv: string[], d: WatchdogDeps): number;
