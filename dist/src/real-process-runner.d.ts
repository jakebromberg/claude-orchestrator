import type { ProcessRunner } from "./types.js";
/**
 * Spawn Claude Code sessions as real child processes.
 *
 * @param options.useApiKey - Bill sessions to the Anthropic API instead of the
 *   Claude Code login. Defaults to the `CLAUDE_ORCHESTRATOR_USE_API_KEY` env var
 *   (i.e. off), so sessions don't silently consume API credits when an
 *   `ANTHROPIC_API_KEY` happens to be exported in the operator's shell.
 */
export declare function createRealProcessRunner(runnerOptions?: {
    useApiKey?: boolean;
}): ProcessRunner;
