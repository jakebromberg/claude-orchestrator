import type { ProcessHandle } from "./types.js";
interface CompletedProcess {
    pid: number;
    issueNumber: number;
    exitCode: number;
}
export declare class ProcessPool {
    private maxParallel;
    private active;
    private completed;
    private waiters;
    constructor(maxParallel: number);
    setMaxParallel(n: number): void;
    /** Hold a slot until the process exits. */
    add(handle: ProcessHandle): void;
    /**
     * Hold a slot until `settled` fulfils or rejects, so the slot spans an
     * issue's whole pipeline (session, post-session check, retries) rather than
     * just the first session. The recorded exit code is still the handle's.
     */
    track(handle: ProcessHandle, settled: Promise<unknown>): void;
    private release;
    get activeCount(): number;
    get isFull(): boolean;
    get activePids(): number[];
    waitForSlot(): Promise<void>;
    waitAll(): Promise<CompletedProcess[]>;
}
export {};
