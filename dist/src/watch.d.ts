import type { Issue, OrchestratorConfig, Status, StatusStore } from "./types.js";
export type WriteFn = (text: string) => void;
export type ReadFileTail = (filePath: string, bytes: number) => string;
export interface WatchOptions {
    config: OrchestratorConfig;
    statusStore: StatusStore;
    write: WriteFn;
    readFileTail?: ReadFileTail;
    interval?: number;
}
export interface WatchHandle {
    stop(): void;
}
export interface RenderOptions {
    config: OrchestratorConfig;
    getStatus: (n: number) => Status;
    getLastLogLine: (issue: Issue) => string;
}
export declare function renderDashboard(options: RenderOptions): string;
export declare function readLastLogLine(logPath: string, readFileTail?: ReadFileTail): string;
export declare function startWatch(options: WatchOptions): WatchHandle;
