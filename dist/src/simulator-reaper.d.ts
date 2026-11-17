import { type ProcRow } from "./ps.js";
/** The bound on every `simctl` and `ps` call here: `simctl` can hang. */
export declare const SIMCTL_TIMEOUT_MS = 30000;
export interface SimulatorReapEvent {
    type: "simulator-reap";
    udid: string;
    reason: "shutdown-leftovers" | "booted-idle";
    action: "shutdown" | "terminate" | "kill";
    /** The processes the action was for or, with `ok` false, the one that failed. */
    pids?: number[];
    ok: boolean;
    /** The failure, when `ok` is false. */
    message?: string;
}
export interface ReaperDeps {
    /** `simctl list devices -j`; throws when it fails or times out. */
    listDevices(): string;
    /** `ps -E` for the given pids, one `pid command environment` line each. */
    processEnv(pids: number[]): string;
    /** `simctl shutdown <udid>`; throws when it fails or times out. */
    shutdown(udid: string): void;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
    log(event: SimulatorReapEvent): void;
    /** Only processes of this user are signalled. */
    uid: number;
}
export interface ReapInput {
    procs: ProcRow[];
    /** Booted devices with no `xcodebuild` or `simctl` running for the watchdog's idle threshold. */
    idleUdids: string[];
    /** Cycles each device's leftovers have been signalled so far, from the last cycle. */
    attempts: Record<string, number>;
}
/** Runs one cycle and returns the attempts to carry to the next: only devices that still have leftovers. Never throws. */
export declare function reapSimulators({ procs, idleUdids, attempts }: ReapInput, deps: ReaperDeps): Record<string, number>;
/** The real seams: `xcrun simctl`, `ps -E` and `process.kill`, each external call bounded by `SIMCTL_TIMEOUT_MS`; `exec` and `uid` are test seams. */
export declare function realReaperDeps({ log, exec, uid }: {
    log: ReaperDeps["log"];
    exec?: (file: string, args: string[], timeoutMs: number) => string;
    uid?: number;
}): ReaperDeps;
