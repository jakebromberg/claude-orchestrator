import { type PressureLevel, type PressurePolicy, type PressureSampler } from "./memory-pressure.js";
type ReapReason = "stale-heartbeat" | "orphan-bound" | "corrupt";
export type LeaseEvent = {
    type: "acquire";
    id: string;
    waitedMs: number;
    level: PressureLevel;
    live: number;
    capacity: number;
} | {
    type: "release";
    id: string;
    exitCode?: number;
} | {
    type: "reap";
    id: string;
    reason: ReapReason;
} | {
    type: "timeout";
    refused: "max-wait" | "stopped";
    waitedMs: number;
} | {
    type: "fail-open";
    reason: "mutex-busy" | "io-error";
    waitedMs: number;
};
export interface LeaseOptions {
    dir: string;
    level: PressureSampler;
    policy: PressurePolicy;
    isAlive?(pid: number): boolean;
    now?(): number;
    sleep?(ms: number): Promise<void>;
    pollMs?: number;
    /** The `CO_LEASE_HOLDER` id this process inherited; a live one admits a nested acquire at once. */
    inheritedHolderId?: string;
    /** True when `CO_PRESSURE_OVERRIDE=critical-as-warning` is in effect; a `warning` level is then recorded as override-produced. */
    override?: boolean;
    /** A throw is warned about once per callback and never changes what the lease does. */
    onEvent?(e: LeaseEvent): void;
    warn?(msg: string): void;
}
/** What a holder file records about the request; `label` replaces `command` when given. */
export interface HolderMeta {
    command: string;
    label?: string;
    cwd: string;
}
interface HolderRecord {
    id: string;
    pid: number;
    childPid?: number;
    command: string;
    cwd: string;
    startedAt: number;
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
    };
    /** Env for the child command; the holder id is never put in `process.env`. */
    childEnv(): Record<string, string>;
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
/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. */
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
/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export declare function leaseStatus(opts: LeaseOptions): LeaseStatus;
/** Production wiring: the real lease directory and the engine's own sampler and policy. Creates nothing on disk. */
export declare function defaultLeaseOptions(env?: NodeJS.ProcessEnv): LeaseOptions;
export {};
