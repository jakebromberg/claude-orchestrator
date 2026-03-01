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
    add(handle) {
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
            if (waiter)
                waiter();
        });
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