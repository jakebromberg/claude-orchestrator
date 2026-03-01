import type { OrchestratorConfig, RawOrchestratorConfig } from "./types.js";
/**
 * Validate a raw orchestrator config and compute wave assignments.
 *
 * Throws a ZodError if structural, referential, or graph validation fails.
 */
export declare function validateConfig(raw: RawOrchestratorConfig): OrchestratorConfig;
