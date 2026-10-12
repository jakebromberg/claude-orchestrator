export class ProcessPool {
    options;
    maxParallel;
    active = [];
    completed = [];
    waiters = [];
    constructor(maxParallel, options = {}) {
        this.options = options;
        this.maxParallel = maxParallel;
    }
    setMaxParallel(n) {
        this.maxParallel = Math.max(1, n);
        this.recheck();
    }
    /** Wake every waiter to re-evaluate the limit; call after the capacity may have changed. */
    recheck() {
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters)
            wake();
    }
    /** Hold a slot until the process exits. */
    add(handle) {
        this.active.push(handle);
        handle.exitCode.then((code) => this.release(handle, code));
    }
    /**
     * Hold a slot until `settled` fulfils or rejects, so the slot spans an
     * issue's whole pipeline (session, post-session check, retries) rather than
     * just the first session. The recorded exit code is still the handle's.
     */
    track(handle, settled) {
        this.active.push(handle);
        settled
            .catch(() => { })
            .then(() => handle.exitCode)
            .then((code) => this.release(handle, code));
    }
    release(handle, exitCode) {
        this.completed.push({
            pid: handle.pid,
            issueNumber: handle.issueNumber,
            exitCode,
        });
        this.active = this.active.filter((h) => h.pid !== handle.pid);
        this.recheck();
    }
    get activeCount() {
        return this.active.length;
    }
    get isFull() {
        return this.active.length >= Math.min(this.maxParallel, this.options.capacity?.() ?? Infinity);
    }
    get activePids() {
        return this.active.map((h) => h.pid);
    }
    /** Resolves `"go"` when a slot is free, or `"stop"` when `shouldStop` ends the wait. */
    async waitForSlot() {
        while (this.isFull) {
            if (this.options.shouldStop?.(this.active.length))
                return "stop";
            await new Promise((resolve) => {
                this.waiters.push(resolve);
            });
        }
        return "go";
    }
    async waitAll() {
        while (this.active.length > 0) {
            await new Promise((resolve) => {
                this.waiters.push(resolve);
            });
        }
        return this.completed;
    }
}
//# sourceMappingURL=process-pool.js.map