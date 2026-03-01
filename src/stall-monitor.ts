export interface StallMonitorOptions {
  stallTimeout: number;
  checkInterval: number;
  getLogSize(): number;
  onStall(): void;
}

export class StallMonitor {
  private options: StallMonitorOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSize = -1;
  private stallMs = 0;
  private fired = false;

  constructor(options: StallMonitorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.options.stallTimeout <= 0) return;

    this.timer = setInterval(() => {
      if (this.fired) return;

      const currentSize = this.options.getLogSize();
      if (currentSize === this.lastSize) {
        this.stallMs += this.options.checkInterval;
        if (this.stallMs >= this.options.stallTimeout) {
          this.fired = true;
          this.stop();
          this.options.onStall();
        }
      } else {
        this.stallMs = 0;
        this.lastSize = currentSize;
      }
    }, this.options.checkInterval);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
