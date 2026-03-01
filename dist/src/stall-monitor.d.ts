export interface StallMonitorOptions {
    stallTimeout: number;
    checkInterval: number;
    getLogSize(): number;
    onStall(): void;
}
export declare class StallMonitor {
    private options;
    private timer;
    private lastSize;
    private stallMs;
    private fired;
    constructor(options: StallMonitorOptions);
    start(): void;
    stop(): void;
}
