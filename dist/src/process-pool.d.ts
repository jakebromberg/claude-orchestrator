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
    add(handle: ProcessHandle): void;
    get activeCount(): number;
    get isFull(): boolean;
    get activePids(): number[];
    waitForSlot(): Promise<void>;
    waitAll(): Promise<CompletedProcess[]>;
}
export {};
