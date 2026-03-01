export class StallMonitor {
    options;
    timer = null;
    lastSize = -1;
    stallMs = 0;
    fired = false;
    constructor(options) {
        this.options = options;
    }
    start() {
        if (this.options.stallTimeout <= 0)
            return;
        this.timer = setInterval(() => {
            if (this.fired)
                return;
            const currentSize = this.options.getLogSize();
            if (currentSize === this.lastSize) {
                this.stallMs += this.options.checkInterval;
                if (this.stallMs >= this.options.stallTimeout) {
                    this.fired = true;
                    this.stop();
                    this.options.onStall();
                }
            }
            else {
                this.stallMs = 0;
                this.lastSize = currentSize;
            }
        }, this.options.checkInterval);
    }
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=stall-monitor.js.map