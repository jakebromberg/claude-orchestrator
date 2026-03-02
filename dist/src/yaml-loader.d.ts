import type { OrchestratorConfig } from "./types.js";
import type { HooksOverride } from "./yaml-types.js";
export interface LoadYamlConfigOptions {
    /** Hook overrides to merge on top of derived hooks. */
    hooksOverride?: HooksOverride;
}
/**
 * Load an orchestrator config from a YAML file.
 *
 * 1. Reads and parses the YAML file
 * 2. Validates against `YamlConfigSchema`
 * 3. Resolves relative paths against the YAML file's directory
 * 4. Derives hooks from YAML fields
 * 5. Merges optional `.hooks.ts` overrides
 * 6. Runs `validateConfig()` (issue graph validation + wave assignment)
 *
 * @param yamlPath - Absolute path to the YAML config file.
 * @param options  - Optional hook overrides.
 */
export declare function loadYamlConfig(yamlPath: string, options?: LoadYamlConfigOptions): Promise<OrchestratorConfig>;
