import type { OrchestratorHooks } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
/**
 * Runs `cmd` under `/bin/sh -c` without blocking the event loop, keeping only
 * the last 64 KiB of combined stdout/stderr. Resolves with that tail on exit 0;
 * rejects with an Error carrying the exit code (or signal) and the tail.
 *
 * `onSpawn` receives the child's PID. If it throws, the child is killed and
 * the promise rejects with that error, but only after the child has exited.
 */
export declare function runShellAsync(cmd: string, cwd: string, env?: Record<string, string>, onSpawn?: (pid: number) => void): Promise<string>;
/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
    readFile?: (path: string) => string;
    /**
     * Runs both the `postSessionCheck` commands and the `onMergeConflict`
     * resolver. Their defaults differ: the check inherits the full environment
     * (it runs the project's own commands, which may need an API key), while the
     * resolver launches `claude` under `claudeExecOptions()`.
     *
     * Overriding this collapses that distinction — an injected runner is used
     * verbatim for both, so the merge-conflict session will authenticate with
     * whatever environment the override passes. Apply `claudeSessionEnv()`
     * yourself in the override if you want sessions on the Claude Code login.
     *
     * May return synchronously or a Promise; both callers `await` the result,
     * and a throw or rejection counts as failure. The check's default is
     * {@link runShellAsync}, which keeps the event loop free; `env` overrides
     * the child's environment and `onSpawn` receives the child's PID (the
     * default runner honors both).
     */
    runCommand?: (cmd: string, cwd: string, env?: Record<string, string>, onSpawn?: (pid: number) => void) => string | Promise<string>;
    /**
     * Used by collision detection to run git commands with an argument array
     * (avoids shell quoting entirely). Defaults to `execFileSync`.
     */
    runGitCommand?: (file: string, args: string[]) => string;
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
