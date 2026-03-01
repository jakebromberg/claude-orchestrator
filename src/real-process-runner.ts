import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import type { ProcessRunner } from "./types.js";

export function createRealProcessRunner(): ProcessRunner {
  return {
    spawn(
      command: string,
      args: string[],
      options: { cwd: string; logFile: string; stderrFile?: string },
    ) {
      const logFd = fs.openSync(options.logFile, "a");
      const stderrFd = options.stderrFile
        ? fs.openSync(options.stderrFile, "a")
        : null;

      // Strip all Claude Code env vars so child sessions don't think they're nested.
      // Use a prefix match rather than hardcoding specific names, since Claude Code
      // may add new env vars in future versions or IDEs may inject their own.
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE")) {
          delete env[key];
        }
      }

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
        if (closed) return;
        closed = true;
        fs.closeSync(logFd);
        if (stderrFd !== null) fs.closeSync(stderrFd);
      }

      const exitCode = new Promise<number>((resolve) => {
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
    kill(pid: number) {
      try {
        process.kill(pid);
      } catch {}
    },
  };
}
