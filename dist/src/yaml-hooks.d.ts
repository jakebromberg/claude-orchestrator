import type { OrchestratorHooks } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
    readFile?: (path: string) => string;
    runCommand?: (cmd: string, cwd: string) => string;
    /**
     * Used by collision detection to check whether a peer's worktree directory
     * is present on disk. Defaults to `node:fs.existsSync`.
     */
    existsSync?: (path: string) => boolean;
    /**
     * Absolute path to the YAML config. Required for `{{CLAIM_NUMBER}}` prompt
     * variable expansion (the resolved command embeds `--config <yamlPath>`).
     * Set automatically by `loadYamlConfig`; tests can pass it explicitly.
     */
    yamlPath?: string;
    /**
     * Override the resolved path to `cli-claim.js`. Defaults to the file
     * sibling of `yaml-hooks.js` in the package install. Set in tests to
     * decouple from the file system.
     */
    claimHelperPath?: string;
}
export declare function buildClaimCommand(yamlPath: string, issueNumber: number, helperPath?: string): string;
/**
 * Derive a full `OrchestratorHooks` object from a parsed YAML config.
 *
 * Pure function with respect to `yaml` — only uses injected `deps` for I/O
 * (reading prompt templates, running post-session commands).
 */
export declare function deriveHooks(yaml: YamlConfig, deps?: DeriveHooksDeps): OrchestratorHooks;
