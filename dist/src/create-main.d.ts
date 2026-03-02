import type { OrchestratorConfig } from "./types.js";
export type ConfigFactory = ((projectRoot: string) => OrchestratorConfig) | ((projectRoot: string) => Promise<OrchestratorConfig>);
export interface MainOptions {
    configs: Record<string, ConfigFactory>;
    argv?: string[];
    projectRoot?: string;
}
export declare function createMain(options: MainOptions): Promise<void>;
