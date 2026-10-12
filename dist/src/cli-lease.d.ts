#!/usr/bin/env node
/**
 * Runs a command under the machine-wide heavy-command lease, or reports who
 * holds it:
 *
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] -- <cmd> [args...]
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] --shell '<command line>'
 *   claude-orchestrator-lease status
 *   claude-orchestrator-lease hook [--print-settings-entry]
 *
 * The slot is held for exactly as long as the command lives, and the command's
 * exit code is passed through. Exit 75 means no slot within the wait cap
 * (rerun); exit 78 means the lease is misconfigured (a relative `CO_LEASE_DIR`).
 *
 * Pure helpers (`parseLeaseArgs`, `runLeased`, `runStatus`) take every external
 * interaction through `LeaseCliDeps`; the file's bottom wires real I/O.
 */
import type { PressureSampler } from "./memory-pressure.js";
import { acquireLease, type LeaseOptions, type LeaseStatus } from "./lease.js";
import { formatAdmitted, formatNoSlot } from "./lease-messages.js";
export { formatAdmitted, formatNoSlot };
/** Exactly one of `argv` (spawned directly) and `shell` (run under `/bin/sh -c`) is set. */
export interface RunArgs {
    kind: "run";
    maxWaitSec?: number;
    label?: string;
    argv?: string[];
    shell?: string;
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
    spawn(file: string, args: string[], opts: {
        env: NodeJS.ProcessEnv;
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
}
export declare function parseLeaseArgs(argv: string[]): LeaseArgs;
/** Prints the holders as JSON; returns the exit code. */
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
