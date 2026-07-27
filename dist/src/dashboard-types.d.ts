import type { OrchestratorConfig, StatusStore, MetadataStore, Logger } from "./types.js";
/** Dependencies for the dashboard server, injectable for testing. */
export interface DashboardDeps {
    statusStore: StatusStore;
    metadataStore: MetadataStore;
    config: OrchestratorConfig;
    logger: Logger;
    /** Read the last N bytes of an issue's log file, keyed by its composite ref. */
    readLogTail: (ref: string, maxBytes: number) => string;
}
/** Options for creating the dashboard server. */
export interface DashboardOptions {
    port?: number;
    host?: string;
}
/** Handle returned by createDashboardServer for lifecycle management. */
export interface DashboardHandle {
    /** The port the server is listening on. */
    port: number;
    /** Stop the server and clean up resources. */
    close(): Promise<void>;
}
