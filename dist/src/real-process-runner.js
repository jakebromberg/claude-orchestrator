import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { claudeSessionEnv } from "./claude-env.js";
/**
 * Spawn Claude Code sessions as real child processes.
 *
 * @param options.useApiKey - Bill sessions to the Anthropic API instead of the
 *   Claude Code login. Defaults to the `CLAUDE_ORCHESTRATOR_USE_API_KEY` env var
 *   (i.e. off), so sessions don't silently consume API credits when an
 *   `ANTHROPIC_API_KEY` happens to be exported in the operator's shell.
 */
export function createRealProcessRunner(runnerOptions = {}) {
    return {
        spawn(command, args, options) {
            const logFd = fs.openSync(options.logFile, "a");
            const stderrFd = options.stderrFile
                ? fs.openSync(options.stderrFile, "a")
                : null;
            // Drop the parent's Claude Code env vars (so the child isn't seen as a
            // nested session) and its API credentials (so the session authenticates
            // with the Claude Code login rather than billing API credits).
            const env = claudeSessionEnv(process.env, runnerOptions);
            const child = nodeSpawn(command, args, {
                cwd: options.cwd,
                stdio: ["ignore", logFd, stderrFd ?? logFd],
                env,
                detached: false,
            });
            // Guard against double-close: both "close" and "error" can fire for
            // the same child process, and closing an already-closed fd throws EBADF.
            let closed = false;
            function closeFds() {
                if (closed)
                    return;
                closed = true;
                fs.closeSync(logFd);
                if (stderrFd !== null)
                    fs.closeSync(stderrFd);
            }
            const exitCode = new Promise((resolve) => {
                child.on("close", (code) => {
                    closeFds();
                    resolve(code ?? 1);
                });
                child.on("error", () => {
                    closeFds();
                    resolve(1);
                });
            });
            return {
                pid: child.pid ?? 0,
                issueNumber: 0,
                exitCode,
            };
        },
        kill(pid) {
            try {
                process.kill(pid);
            }
            catch { }
        },
    };
}
//# sourceMappingURL=real-process-runner.js.map