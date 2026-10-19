import type { OrchestratorHooks } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
/** The largest delay `setTimeout` honours; Node fires a longer one after 1 ms. */
export declare const MAX_TIMER_MS = 2147483647;
/**
 * Sends SIGKILL to the process group of every bounded {@link runShellAsync} command still live, synchronously. A
 * bounded command runs in its own group, so the terminal's Ctrl-C does not reach it; this runs on the process's `exit`
 * event, so an engine that exits (its SIGINT/SIGTERM handler ends in `process.exit`) does not leave a deploy running
 * behind it. Exit is final and the kill-after-grace timer dies with the engine, so there is no grace: a member that
 * traps SIGTERM (including one a timeout already sent SIGTERM to) must not outlive the engine. ESRCH is ignored.
 */
export declare function stopLiveCommandGroups(): void;
/**
 * Runs `cmd` under `/bin/sh -c` without blocking the event loop, keeping only
 * the last 64 KiB of combined stdout/stderr. Resolves with that tail on exit 0;
 * rejects with an Error carrying the exit code (or signal) and the tail. The
 * exit code is also on the error as `status`, the field an `execSync` failure
 * uses; a timeout or a signal leaves it unset.
 *
 * `onSpawn` receives the child's PID. If it throws, the child is killed and
 * the promise rejects with that error, but only after the child has exited.
 *
 * `timeoutMs` (unset, 0, or above {@link MAX_TIMER_MS}: none) bounds the run. With
 * a bound the shell runs in its own process group, and on timeout the whole group
 * gets SIGTERM (as `execSync` sent the shell), so a script's trap can clean up and
 * a grandchild cannot carry on; any member still alive `killGraceMs` later gets
 * SIGKILL. The promise rejects at the timeout, without waiting for the pipes a
 * grandchild may still hold open. If the engine exits first, any group still live
 * gets SIGKILL at once ({@link stopLiveCommandGroups}). Without a bound the shell stays in
 * the engine's group, as before.
 */
export declare function runShellAsync(cmd: string, cwd: string, env?: Record<string, string>, onSpawn?: (pid: number) => void, timeoutMs?: number, killGraceMs?: number): Promise<string>;
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
