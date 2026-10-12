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

export class ProcessPool {
  private maxParallel: number;
  private active: ProcessHandle[] = [];
  private completed: CompletedProcess[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    maxParallel: number,
    private readonly options: ProcessPoolOptions = {},
  ) {
    this.maxParallel = maxParallel;
  }

  setMaxParallel(n: number): void {
    this.maxParallel = Math.max(1, n);
    this.recheck();
  }

  /** Wake every waiter to re-evaluate the limit; call after the capacity may have changed. */
  recheck(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Hold a slot until the process exits. */
  add(handle: ProcessHandle): void {
    this.active.push(handle);
    handle.exitCode.then((code) => this.release(handle, code));
  }

  /**
   * Hold a slot until `settled` fulfils or rejects, so the slot spans an
   * issue's whole pipeline (session, post-session check, retries) rather than
   * just the first session. The recorded exit code is still the handle's.
   */
  track(handle: ProcessHandle, settled: Promise<unknown>): void {
    this.active.push(handle);
    settled
      .catch(() => {})
      .then(() => handle.exitCode)
      .then((code) => this.release(handle, code));
  }

  private release(handle: ProcessHandle, exitCode: number): void {
    this.completed.push({
      pid: handle.pid,
      issueNumber: handle.issueNumber,
      exitCode,
    });
    this.active = this.active.filter((h) => h.pid !== handle.pid);
    this.recheck();
  }

  get activeCount(): number {
    return this.active.length;
  }

  get isFull(): boolean {
    return this.active.length >= Math.min(this.maxParallel, this.options.capacity?.() ?? Infinity);
  }

  get activePids(): number[] {
    return this.active.map((h) => h.pid);
  }

  /** Resolves `"go"` when a slot is free, or `"stop"` when `shouldStop` ends the wait. */
  async waitForSlot(): Promise<"go" | "stop"> {
    while (this.isFull) {
      if (this.options.shouldStop?.(this.active.length)) return "stop";
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    return "go";
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
