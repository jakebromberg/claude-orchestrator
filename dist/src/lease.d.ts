import { type Stats } from "node:fs";
import { type PressureLevel, type PressurePolicy, type PressureSampler } from "./memory-pressure.js";
/** The longest a detached holder may be set to live: the largest Bash call timeout (10 min) plus hook mode's 60 s grace. */
export declare const DETACHED_TTL_MAX_MS = 660000;
type ReapReason = "stale-heartbeat" | "orphan-bound" | "corrupt" | "dead-session" | "expired";
export type LeaseEvent = {
    type: "acquire";
    id: string;
    waitedMs: number;
    level: PressureLevel;
    live: number;
    capacity: number;
    override?: true;
} | {
    type: "release";
    id: string;
    heldMs: number;
    exitCode?: number;
} | {
    type: "reap";
    id: string;
    reason: ReapReason;
}
/** `level` is the confirmed level of a `stopped` refusal. */
 | {
    type: "timeout";
    refused: "max-wait" | "stopped";
    waitedMs: number;
    level?: PressureLevel;
}
/** `code` and `message` describe the I/O error; a busy mutex has neither. */
 | {
    type: "fail-open";
    reason: "mutex-busy" | "io-error";
    waitedMs: number;
    code?: string;
    message?: string;
};
export interface LeaseOptions {
    dir: string;
    level: PressureSampler;
    policy: PressurePolicy;
    isAlive?(pid: number): boolean;
    /**
     * Wall-clock epoch milliseconds (default `Date.now`). It dates heartbeats, which are compared with mtimes the kernel
     * sets on writes, so any other clock (monotonic, scripted, offset) makes live holders read as stale and reaped.
     */
    now?(): number;
    sleep?(ms: number): Promise<void>;
    pollMs?: number;
    /** The `CO_LEASE_HOLDER` id this process inherited; a live one admits a nested acquire at once. */
    inheritedHolderId?: string;
    /** A throw is warned about once per callback and never changes what the lease does. */
    onEvent?(e: LeaseEvent): void;
    warn?(msg: string): void;
}
/**
 * What a holder file records about the request; `label` replaces `command` when given. `detached` records a holder
 * for a process that is not this one (hook mode): `id` is used as given, `sessionPid` is the liveness PID, and no
 * heartbeat runs. `expiresAt` is read when the holder is written, so it may be a getter that counts from admission.
 */
export interface HolderMeta {
    command: string;
    label?: string;
    cwd: string;
    detached?: {
        id: string;
        sessionPid: number;
        expiresAt: number;
    };
}
interface HolderRecord {
    id: string;
    pid: number;
    childPid?: number;
    command: string;
    cwd: string;
    startedAt: number;
    /** Detached holders only: epoch ms after which the holder is expired. */
    expiresAt?: number;
    level: PressureLevel;
    override?: true;
}
/** A live holder as `leaseStatus` reports it. */
export interface HolderInfo extends HolderRecord {
    ageSec: number;
}
export interface LeaseStatus {
    level: PressureLevel;
    capacity: number;
    live: HolderInfo[];
}
/**
 * A holder stays live only while this process's event loop runs its 30 s heartbeat, or while a child PID recorded
 * through `setChildPid` is alive. A caller that blocks the event loop for 90 s (`execSync`, `spawnSync`) without
 * recording a child is reaped while its command still runs, and stays out of the count until it releases.
 */
export interface LeaseHandle {
    /** `null` for an unleased (fail-open) handle. */
    id: string | null;
    leased: boolean;
    /** `live` counts this holder. */
    admission: {
        waitedMs: number;
        level: PressureLevel;
        live: number;
        capacity: number;
        override?: true;
    };
    /** Env for the child command; the holder id is never put in `process.env`. */
    childEnv(): Record<string, string>;
    /**
     * Records the heavy command's PID right after an async spawn, so the holder stays live while that process runs,
     * even when this one is blocked or killed (up to the 2 h orphan bound). Ignored after release, for a value that is
     * not a positive integer, and once the holder has been reaped: a reaped holder's file is not recreated.
     */
    setChildPid(pid: number): void;
    release(outcome?: {
        exitCode?: number;
    }): void;
}
export interface LeaseRefusal {
    refused: "max-wait" | "stopped";
    waitedMs: number;
    level: PressureLevel;
    live: number;
}
/** The lease's directory rule, given `lstat` stats: a real directory (not a symlink) this user owns. A platform without uids (Windows) skips the ownership check. */
export declare function isOwnDir(st: Stats): boolean;
/** The one default diagnostics writer, shared with the event sink. Messages carry their own `lease:` prefix. */
export declare function defaultWarn(msg: string): void;
export declare function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null;
/**
 * Polls (3 s ± 1 s, never spinning) until admitted. `stopWhen` is checked on
 * every poll, and a stop is confirmed with a `level.fresh()` re-read before it
 * is returned, so one stale cached sample cannot end a wave.
 */
export declare function acquireLease(opts: LeaseOptions, meta: HolderMeta, wait?: {
    maxWaitMs?: number;
    onWait?(s: LeaseStatus): void;
    stopWhen?(s: LeaseStatus): boolean;
}): Promise<LeaseHandle | LeaseRefusal>;
/**
 * Releases a detached holder by id from any process; idempotent. Returns whether a holder file was removed, and emits
 * one `release` event with `heldMs` only then. It removes only a valid detached record (one with `expiresAt`): a
 * wrapper's own holder and a corrupt file are left to their owner and the reaper. An id with a character outside
 * `[A-Za-z0-9_-]` names no holder, and a holders directory that breaks the lease's directory rule (a symlink, or
 * another user's) is not read, so neither can reach a file outside `holders/`.
 */
export declare function releaseHolder(opts: LeaseOptions, id: string): boolean;
/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export declare function leaseStatus(opts: LeaseOptions): LeaseStatus;
/**
 * Production wiring: the real lease directory, the engine's own sampler and policy, and the `events.jsonl` sink. Creates nothing on disk.
 * `overrides.level` replaces the sampler (none is built), and `overrides.warn` is the one writer for the lease, the sink,
 * the policy and the sampler it builds; without it each keeps its stderr default.
 * The writer is wrapped once so it cannot change what the lease does: a writer that throws is silenced (the line is dropped and nothing reports it), so pass a bound function,
 * and the returned `warn` is that wrapper, not the caller's function.
 */
export declare function defaultLeaseOptions(env?: NodeJS.ProcessEnv, overrides?: {
    level?: PressureSampler;
    warn?: (msg: string) => void;
}): LeaseOptions;
export {};
