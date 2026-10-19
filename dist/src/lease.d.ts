import { type HeadroomSampler } from "./headroom-sampler.js";
import { ensureOwnSubdir, isOwnDir } from "./lease-dir.js";
import { type MemorySignals, type PressureLevel, type PressurePolicy, type PressureSampler } from "./memory-pressure.js";
import { isPid } from "./ps.js";
export { ensureOwnSubdir, isOwnDir, isPid };
/** The longest a detached holder may be set to live: the largest Bash call timeout (10 min) plus hook mode's 60 s grace. */
export declare const DETACHED_TTL_MAX_MS = 660000;
type ReapReason = "stale-heartbeat" | "orphan-bound" | "corrupt" | "dead-session" | "expired";
export type LeaseEvent = {
    type: "acquire";
    id: string;
    waitedMs: number;
    level: PressureLevel;
    step: number;
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
    refused: "max-wait" | "stopped" | "disk-full";
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
/** Cumulative CPU tick counters over all cores. */
export interface CpuTicks {
    idle: number;
    total: number;
}
/** `LeaseOptions.cpuTimes` in production: the `os.cpus()` counters, so no process is spawned. */
export declare function osCpuTicks(): CpuTicks;
export interface LeaseOptions {
    dir: string;
    level: PressureSampler;
    /**
     * The machine-wide headroom step. When set, heavy capacity is `headroomCapacity(step, policy)` and `level` is only a
     * view of it (`defaultLeaseOptions` builds both from one sampler); when absent, capacity comes from `level` alone
     * (`warning` → `policy.heavyWarning`), a path for tests and callers that inject `level`; production callers always have it.
     */
    headroom?: HeadroomSampler;
    policy: PressurePolicy;
    /** The machine-wide ceiling of implementer sessions (`CO_LEASE_SESSION_SLOTS`, default 6); steps below 4 are capped by it. */
    sessionSlots?: number;
    isAlive?(pid: number): boolean;
    /**
     * Wall-clock epoch milliseconds (default `Date.now`). It dates heartbeats, which are compared with mtimes the kernel
     * sets on writes, so any other clock (monotonic, scripted, offset) makes live holders read as stale and reaped.
     */
    now?(): number;
    sleep?(ms: number): Promise<void>;
    pollMs?: number;
    /** Reads the CPU tick counters for the gated tickets' CPU gate; absent, or a throw or empty read, means the CPU is unknown and passes. */
    cpuTimes?(): CpuTicks;
    /** The `CO_LEASE_HOLDER` id this process inherited; a live one admits a nested acquire at once. */
    inheritedHolderId?: string;
    /** A throw is warned about once per callback and never changes what the lease does. */
    onEvent?(e: LeaseEvent): void;
    warn?(msg: string): void;
}
/**
 * What a holder file records about the request; `label` replaces `command` when given. `detached` records a holder
 * for a process that is not this one (hook mode): `id` is used as the holder id and must match `[A-Za-z0-9_-]{1,160}`,
 * `sessionPid` is the liveness PID and must be a positive integer, and `expiresAt` must be finite (acquiring throws a
 * `TypeError` otherwise); no heartbeat runs. `expiresAt` is read when the holder is written, so it may be a getter that
 * counts from admission. Acquiring an `id` whose holder is already live admits at once without a second holder or count:
 * two hook installs handling one call share one slot, and the borrowed handle's `release` does nothing.
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
    /** Admit only while heavy-queue's gates pass (CPU under 0.75, nothing suspended, 20 s since the last gated start), or when nothing is live. Set only by the heavy-queue front end. */
    gated?: boolean;
    /** Marks a holder whose front end owns its process group and may suspend it under overload. Set only by the heavy-queue front end. */
    suspendable?: boolean;
}
interface HolderRecord {
    id: string;
    pid: number;
    childPid?: number;
    /** The command's own process group, when its front end started it in one (for the watchdog and the suspender). */
    pgid?: number;
    /** The front end may suspend this holder's group. */
    suspendable?: true;
    command: string;
    cwd: string;
    startedAt: number;
    /** Detached holders only: epoch ms after which the holder is expired. */
    expiresAt?: number;
    level: PressureLevel;
    override?: true;
    /** Set while the holder's group is stopped; a gated ticket is not admitted while any live holder has it. */
    suspended?: true;
}
/** A live holder as `leaseStatus` reports it. */
export interface HolderInfo extends HolderRecord {
    ageSec: number;
}
export interface LeaseStatus {
    level: PressureLevel;
    capacity: number;
    /** The headroom step, 0 to 4; derived from `level` when no `headroom` sampler is set. */
    step: number;
    /** The kernel signals behind the step; `null` after a failed guarded read, and when no `headroom` sampler is set. */
    signals: MemorySignals | null;
    live: HolderInfo[];
    /** Set by `leaseStatus` only: the session class's capacity at the same reading, and its live holders. */
    sessions?: {
        capacity: number;
        live: HolderInfo[];
    };
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
    setChildPid(pid: number, pgid?: number): void;
    release(outcome?: {
        exitCode?: number;
    }): void;
}
export interface LeaseRefusal {
    refused: "max-wait" | "stopped" | "disk-full";
    waitedMs: number;
    level: PressureLevel;
    live: number;
    /** The out-of-space error code of a `disk-full` refusal. */
    code?: string;
}
/**
 * The CPU busy share, under the mutex: 1 minus the idle share of the ticks since the reading in `cpu.json`. A reading
 * under 2 s old is returned as stored, one 2 to 10 s old is the base of a new delta (and is replaced), and an older,
 * future-dated or missing one is replaced and yields `null`, so the next poll has a delta. Unknown CPU reads as 0 (idle).
 */
export declare function cpuBusy(opts: LeaseOptions, nowMs: number): number | null;
/** Whether `ms` has passed since the mark `name` in the lease directory; a missing mark, or one from the future, reads as elapsed. */
export declare function markElapsed(dir: string, name: string, nowMs: number, ms: number): boolean;
/** Stamps the mark `name` in the lease directory with `nowMs`. */
export declare function writeMark(dir: string, name: string, nowMs: number): void;
/** The one default diagnostics writer, shared with the event sink. Messages carry their own `lease:` prefix. */
export declare function defaultWarn(msg: string): void;
/** A single non-blocking attempt: a handle, or `null` when not admitted this poll (a full disk included: it is never failed open, and emits a `timeout` event with `refused: "disk-full"`). Throws a `TypeError` on an invalid detached id, session PID or `expiresAt`. */
export declare function tryAcquireLease(opts: LeaseOptions, meta: HolderMeta): LeaseHandle | null;
/**
 * Polls (3 s ± 1 s, never spinning) until admitted, in the order waiters arrived: each waits behind a ticket in
 * `<dir>/waiting/`, which it removes when it is admitted, when it gives up and when this returns or throws. `stopWhen` is checked on every poll, and a stop is confirmed with a
 * `level.fresh()` re-read before it is returned, so one stale cached sample cannot end a wave. `onWait` runs on each poll
 * that neither admits nor refuses, and also receives `waitedMs`: the wait so far, measured on `LeaseOptions.now` the
 * same way as an admission's or refusal's `waitedMs`, so a progress line can throttle on it without a clock of its own.
 */
export declare function acquireLease(opts: LeaseOptions, meta: HolderMeta, wait?: LeaseWait): Promise<LeaseHandle | LeaseRefusal>;
/** What a session holder records; it is never detached, gated or suspendable. */
export type SessionMeta = Pick<HolderMeta, "command" | "label" | "cwd">;
/**
 * `acquireLease` for one implementer session of an engine, from the machine-wide pool of the session row (`sessions/`,
 * FIFO tickets in `sessions-waiting/`; 6, 4, 2, 1 and 0 sessions at steps 4 to 0, capped by `LeaseOptions.sessionSlots`).
 * The holder lives in the calling process and stays live only while that process's 30 s heartbeat runs: a stopped engine
 * frees its slots after 90 s, whatever its `claude` children are doing. The stop rule is `wait.stopWhen`, as for a heavy
 * acquire, and it sees the session holders and capacity. Interactive sessions take no slot.
 */
export declare function acquireSessionLease(opts: LeaseOptions, meta: SessionMeta, wait?: LeaseWait): Promise<LeaseHandle | LeaseRefusal>;
type LeaseWait = {
    maxWaitMs?: number;
    onWait?(s: LeaseStatus & {
        waitedMs: number;
    }): void;
    stopWhen?(s: LeaseStatus): boolean;
};
/**
 * Releases a detached holder by id from any process; idempotent. Returns whether a holder file was removed, and emits
 * one `release` event with `heldMs` only then. It removes only a valid detached record (one with `expiresAt`): a
 * wrapper's own holder and a corrupt file are left to their owner and the reaper. An id that is not 1 to 160 of
 * `[A-Za-z0-9_-]` names no holder, and a holders or lease directory that breaks the directory rule (a symlink, or
 * another user's) is not read, so neither can reach a file outside `holders/`.
 */
export declare function releaseHolder(opts: LeaseOptions, id: string): boolean;
/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export declare function leaseStatus(opts: LeaseOptions): LeaseStatus;
/**
 * Production wiring: the real lease directory, the engine's own sampler and policy, and the `events.jsonl` sink. Creates nothing on disk.
 * `overrides.level` replaces the sampler (none is built, so the lease sizes capacity from that level alone: warning gives `heavyWarning`, 1, not the default step table's 3 or 2; a test-only path, and every production caller passes no `level`), and `overrides.warn` is the one writer for the lease, the sink,
 * the policy and the sampler it builds; without it each keeps its stderr default.
 * The writer is wrapped once so it cannot change what the lease does: a writer that throws is silenced (the line is dropped and nothing reports it), so pass a bound function,
 * and the returned `warn` is that wrapper, not the caller's function.
 */
export declare function defaultLeaseOptions(env?: NodeJS.ProcessEnv, overrides?: {
    level?: PressureSampler;
    warn?: (msg: string) => void;
}): LeaseOptions;
