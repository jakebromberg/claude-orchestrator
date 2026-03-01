import type { ProcessHandle } from "./types.js";

interface CompletedProcess {
  pid: number;
  issueNumber: number;
  exitCode: number;
}

export class ProcessPool {
  private maxParallel: number;
  private active: ProcessHandle[] = [];
  private completed: CompletedProcess[] = [];
  private waiters: Array<() => void> = [];

  constructor(maxParallel: number) {
    this.maxParallel = maxParallel;
  }

  setMaxParallel(n: number): void {
    this.maxParallel = Math.max(1, n);
  }

  add(handle: ProcessHandle): void {
    this.active.push(handle);
    handle.exitCode.then((code) => {
      this.completed.push({
        pid: handle.pid,
        issueNumber: handle.issueNumber,
        exitCode: code,
      });
      this.active = this.active.filter((h) => h.pid !== handle.pid);
      // Wake up any waiters
      const waiter = this.waiters.shift();
      if (waiter) waiter();
    });
  }

  get activeCount(): number {
    return this.active.length;
  }

  get isFull(): boolean {
    return this.active.length >= this.maxParallel;
  }

  get activePids(): number[] {
    return this.active.map((h) => h.pid);
  }

  async waitForSlot(): Promise<void> {
    if (!this.isFull) return;
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async waitAll(): Promise<CompletedProcess[]> {
    while (this.active.length > 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    return this.completed;
  }
}
