import type { RunRecord } from "./types.js";
export type { RunRecord } from "./types.js";
export declare function writeRunRecord(configDir: string, record: RunRecord): void;
export declare function listRuns(configDir: string): RunRecord[];
