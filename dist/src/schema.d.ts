import type { OrchestratorConfig, RawOrchestratorConfig } from "./types.js";
/** Options for `validateConfig`. */
export interface ValidateConfigOptions {
    /**
     * Files to exclude when checking for `ownsFiles` conflicts across parallel
     * issues. Combine the config-level `sharedFiles` allowlist and any
     * `appendableFiles` paths here — the wave planner will treat overlaps on
     * these files as safe.
     */
    ignoredOwnsFiles?: string[];
}
/**
 * Validate a raw orchestrator config and compute wave assignments.
 *
 * Throws a ZodError if structural, referential, or graph validation fails.
 */
export declare function validateConfig(raw: RawOrchestratorConfig, options?: ValidateConfigOptions): OrchestratorConfig;
