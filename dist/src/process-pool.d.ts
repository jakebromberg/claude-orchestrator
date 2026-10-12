import type { ProcessHandle } from "./types.js";
interface CompletedProcess {
    pid: number;
    issueNumber: number;
    exitCode: number;
}
export interface ProcessPoolOptions {
    /** Live slot limit; the effective limit is `min(maxParallel, capacity())`. */
    capacity?: () => number;
    /** Called with the active count each time `waitForSlot` finds the pool full; true ends the wait with `"stop"`. */
    shouldStop?: (active: number) => boolean;
}
export declare class ProcessPool {
    private readonly options;
    private maxParallel;
    private active;
    private completed;
    private waiters;
    constructor(maxParallel: number, options?: ProcessPoolOptions);
    setMaxParallel(n: number): void;
    /** Wake every waiter to re-evaluate the limit; call after the capacity may have changed. */
    recheck(): void;
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
    /** Resolves `"go"` when a slot is free, or `"stop"` when `shouldStop` ends the wait. */
    waitForSlot(): Promise<"go" | "stop">;
    waitAll(): Promise<CompletedProcess[]>;
}
export {};
