import type { OrchestratorHooks } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
    readFile?: (path: string) => string;
    runCommand?: (cmd: string, cwd: string) => string;
}
/**
 * Derive a full `OrchestratorHooks` object from a parsed YAML config.
 *
 * Pure function with respect to `yaml` — only uses injected `deps` for I/O
 * (reading prompt templates, running post-session commands).
 */
export declare function deriveHooks(yaml: YamlConfig, deps?: DeriveHooksDeps): OrchestratorHooks;
