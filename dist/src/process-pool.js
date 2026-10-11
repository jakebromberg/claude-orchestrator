export class ProcessPool {
    maxParallel;
    active = [];
    completed = [];
    waiters = [];
    constructor(maxParallel) {
        this.maxParallel = maxParallel;
    }
    setMaxParallel(n) {
        this.maxParallel = Math.max(1, n);
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
        // Wake up any waiters
        const waiter = this.waiters.shift();
        if (waiter)
            waiter();
    }
    get activeCount() {
        return this.active.length;
    }
    get isFull() {
        return this.active.length >= this.maxParallel;
    }
    get activePids() {
        return this.active.map((h) => h.pid);
    }
    async waitForSlot() {
        if (!this.isFull)
            return;
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
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