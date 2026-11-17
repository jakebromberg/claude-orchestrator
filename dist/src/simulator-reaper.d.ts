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
/** `main` is `~/Library/Developer/CoreSimulator/Devices`; `xctest` is the test clones' set, `~/Library/Developer/XCTestDevices`. */
export type DeviceSet = "main" | "xctest";
export interface ReaperDeps {
    /** `simctl list devices -j` for a device set; throws when it fails or times out. */
    listDevices(set: DeviceSet): string;
    /** `ps -E` for the given pids, one `pid command environment` line each. */
    processEnv(pids: number[]): string;
    /** `simctl shutdown <udid>` in the device's set; throws when it fails or times out. */
    shutdown(udid: string, set: DeviceSet): void;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
    log(event: SimulatorReapEvent): void;
    /** Only processes of this user are signalled. */
    uid: number;
}
export interface ReapInput {
    procs: ProcRow[];
    /** Booted devices with no `xcodebuild` or `simctl` running for the watchdog's idle threshold; only those of the `xctest` set are shut down. */
    idleUdids: string[];
    /** Cycles each device's leftovers have been signalled so far, from the last cycle. */
    attempts: Record<string, number>;
}
/**
 * Runs one cycle and returns the attempts to carry to the next: only devices that still have leftovers. Never throws. A device is acted on
 * only when the list of its own set explicitly reports it `Shutdown` (or, for the idle shutdown, an XCTestDevices clone `Booted`): `simctl
 * list` covers one set, so a device it does not name, an empty list and an unreadable one all mean unknown, and nothing is done.
 */
export declare function reapSimulators({ procs, idleUdids, attempts }: ReapInput, deps: ReaperDeps): Record<string, number>;
/** The real seams: `xcrun simctl`, `ps -E` and `process.kill`, each external call bounded by `SIMCTL_TIMEOUT_MS`; `exec`, `uid`, `testSetDir` and `exists` are test seams. A test set that does not exist lists no devices. */
export declare function realReaperDeps({ log, exec, uid, testSetDir, exists, }: {
    log: ReaperDeps["log"];
    exec?: (file: string, args: string[], timeoutMs: number) => string;
    uid?: number;
    testSetDir?: string;
    exists?: (dir: string) => boolean;
}): ReaperDeps;
