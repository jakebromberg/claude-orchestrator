/**
 * The lease CLI's run function and its dependency seam, with no load-time work so
 * other modules can import it. `cli-lease.ts` (the bin, which runs a startup check
 * at load) re-exports these names and must never be imported by the library.
 *
 * Pure helpers (`parseLeaseArgs`, `runLeased`, `runStatus`) take every external
 * interaction through `LeaseCliDeps`; `cliLeaseDeps` wires real I/O.
 */
import type { PressureSampler } from "./memory-pressure.js";
import { acquireLease, type LeaseOptions, type LeaseStatus } from "./lease.js";
/** Exactly one of `argv` (spawned directly) and `shell` (run under `/bin/sh -c`) is set. */
export interface RunArgs {
    kind: "run";
    maxWaitSec?: number;
    label?: string;
    argv?: string[];
    shell?: string;
    /** Front-end options (heavy-queue); no CLI flag sets them. Any one of the three skips the ancestor hook-slot borrow. */
    gated?: boolean;
    /** Runs the command as `taskpolicy -b` in its own process group; signals go to the group after a SIGCONT. */
    background?: boolean;
    /** Marks the holder as one the front end may suspend, unless `noSuspend` or `HEAVY_QUEUE_NO_SUSPEND=1` in `deps.env`. */
    suspendable?: boolean;
    noSuspend?: boolean;
}
export type LeaseArgs = RunArgs | {
    kind: "status";
};
/** The slice of a `ChildProcess` the run loop uses. */
export interface LeaseChild {
    pid?: number;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: "error", cb: (err: NodeJS.ErrnoException) => void): unknown;
}
export interface LeaseCliDeps {
    /** Throws on a configuration error (a relative `CO_LEASE_DIR`). */
    leaseOptions(): LeaseOptions;
    acquire: typeof acquireLease;
    leaseStatus(opts: LeaseOptions): LeaseStatus;
    /** PIDs of this process's ancestors, nearest first; `[]` when they cannot be read. */
    ancestors(): number[];
    spawn(file: string, args: string[], opts: {
        env: NodeJS.ProcessEnv;
        detached?: boolean;
    }): LeaseChild;
    env: NodeJS.ProcessEnv;
    cwd: string;
    out(text: string): void;
    err(line: string): void;
    /** `process` in production: `kill(pid, sig)` on its own `pid` re-raises a signal that arrives while waiting. */
    signals: {
        on(sig: NodeJS.Signals, fn: () => void): unknown;
        off(sig: NodeJS.Signals, fn: () => void): unknown;
        kill(pid: number, sig: NodeJS.Signals): unknown;
        pid: number;
    };
    /** What a suspendable, background run needs to suspend itself; absent, it never does. */
    governor?: {
        /** Calls `fn` every `ms` until the returned function is called. */
        every(fn: () => void, ms: number): () => void;
        /** The command line of the process group's leader; throws when it cannot be read. */
        processCommand(pgid: number): string;
    };
}
export declare function parseLeaseArgs(argv: string[]): LeaseArgs;
export declare function runStatus(d: LeaseCliDeps): number;
/** Waits for a slot, runs the command with it held, and returns the exit code to pass through. */
export declare function runLeased(args: RunArgs, d: LeaseCliDeps): Promise<number>;
/**
 * The deps `main` runs with: every lease, sink, policy and sampler diagnostic goes through `err`.
 * `base.env` replaces `process.env` everywhere the CLI reads the environment (the lease options, `CO_LEASE_MAX_WAIT` and the child's env);
 * `base.level` replaces the sampler, so none is built. `main` passes neither; tests pass both to stay hermetic.
 */
export declare function cliLeaseDeps(err: (line: string) => void, base?: {
    env?: NodeJS.ProcessEnv;
    level?: PressureSampler;
}): LeaseCliDeps;
