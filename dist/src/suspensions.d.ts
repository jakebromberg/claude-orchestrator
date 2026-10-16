export type SuspensionArgs = {
    kind: "suspend";
    raw: string;
    pgid: number;
    by: string;
    reason: string;
    remindMs: number;
    recordOnly: boolean;
} | {
    kind: "resume";
    raw: string;
    pgid: number;
};
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
export declare function parseSuspensionArgs(argv: string[]): SuspensionArgs;
/** What `suspend` records for a process group, in `<lease dir>/suspensions/<pgid>.json`. `at` and `remindAt` are ISO timestamps; `leader` is the command of the member whose pid is the pgid, or `null` when it has exited. */
export interface SuspensionRecord {
    pgid: number;
    by: string;
    reason: string;
    at: string;
    remindAt: string;
    leader: string | null;
}
/** The record file of a process group: the one place that names the `suspensions/` path. */
export declare function suspensionFile(dir: string, pgid: number): string;
/** Writes `record` through the lease's directory rule; throws when the group already has one. */
export declare function writeSuspension(dir: string, record: SuspensionRecord): void;
/** Removes the record of `pgid`; returns whether one existed. */
export declare function removeSuspension(dir: string, pgid: number): boolean;
/** The valid records in `<dir>/suspensions`: a name that is not a canonical `<pid>.json` (no leading zero), a temp file, an unreadable or invalid body (`at` and `remindAt` must parse as dates), or a body whose pgid is not its name is skipped. Creates nothing; a missing, symlinked or foreign directory reads as empty. */
export declare function readSuspensions(dir: string): SuspensionRecord[];
/** Runs `suspend` or `resume` (`argv[0]`): exit 0 done, 1 refused or failed, 64 usage. A suspend writes the record before the signal; a resume signals before it removes the record. */
export declare function runSuspension(argv: string[], d: SuspensionDeps): number;
/** The entry point `cli-lease.ts` dispatches `suspend` and `resume` to: real `ps`, signals and clock, the lease directory from the environment (exit 78 when it is misconfigured). */
export declare function runSuspensionCli(argv: string[]): number;
