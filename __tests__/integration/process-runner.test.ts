import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRealProcessRunner } from "../../src/real-process-runner.js";

describe("createRealProcessRunner (integration)", () => {
  let tmpDir: string;
  let runner: ReturnType<typeof createRealProcessRunner>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    runner = createRealProcessRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exit code 0 and writes log file for successful command", async () => {
    const logFile = path.join(tmpDir, "success.log");

    const handle = runner.spawn("node", ["--version"], {
      cwd: tmpDir,
      logFile,
    });

    const exitCode = await handle.exitCode;

    expect(exitCode).toBe(0);
    expect(handle.pid).toBeGreaterThan(0);
    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("returns non-zero exit code for failing command", async () => {
    const logFile = path.join(tmpDir, "fail.log");

    const handle = runner.spawn(
      "node",
      ["-e", "process.exit(42)"],
      { cwd: tmpDir, logFile },
    );

    const exitCode = await handle.exitCode;

    expect(exitCode).toBe(42);
  });

  it("captures both stdout and stderr in the log file", async () => {
    const logFile = path.join(tmpDir, "both.log");

    const handle = runner.spawn(
      "node",
      ["-e", 'console.log("STDOUT_LINE"); console.error("STDERR_LINE");'],
      { cwd: tmpDir, logFile },
    );

    await handle.exitCode;

    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent).toContain("STDOUT_LINE");
    expect(logContent).toContain("STDERR_LINE");
  });

  it("strips all CLAUDE-prefixed env vars from child process", async () => {
    const logFile = path.join(tmpDir, "env.log");
    const saved: Record<string, string | undefined> = {};
    const testVars = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CUSTOM_VAR"];

    try {
      for (const key of testVars) {
        saved[key] = process.env[key];
        process.env[key] = "test-value";
      }

      const handle = runner.spawn(
        "node",
        [
          "-e",
          `console.log(JSON.stringify(
            Object.keys(process.env).filter(k => k.startsWith("CLAUDE"))
          ))`,
        ],
        { cwd: tmpDir, logFile },
      );

      await handle.exitCode;

      const logContent = fs.readFileSync(logFile, "utf-8");
      const claudeVars = JSON.parse(logContent.trim());
      expect(claudeVars).toEqual([]);
    } finally {
      for (const key of testVars) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    }
  });

  it("captures stderr to separate file when stderrFile is provided", async () => {
    const logFile = path.join(tmpDir, "stdout-only.log");
    const stderrFile = path.join(tmpDir, "stderr-only.log");

    const handle = runner.spawn(
      "node",
      ["-e", 'console.log("STDOUT_LINE"); console.error("STDERR_LINE");'],
      { cwd: tmpDir, logFile, stderrFile },
    );

    await handle.exitCode;

    const logContent = fs.readFileSync(logFile, "utf-8");
    const stderrContent = fs.readFileSync(stderrFile, "utf-8");
    expect(logContent).toContain("STDOUT_LINE");
    expect(logContent).not.toContain("STDERR_LINE");
    expect(stderrContent).toContain("STDERR_LINE");
    expect(stderrContent).not.toContain("STDOUT_LINE");
  });

  it("falls back to logFile for stderr when stderrFile is absent", async () => {
    const logFile = path.join(tmpDir, "combined.log");

    const handle = runner.spawn(
      "node",
      ["-e", 'console.log("STDOUT_LINE"); console.error("STDERR_LINE");'],
      { cwd: tmpDir, logFile },
    );

    await handle.exitCode;

    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent).toContain("STDOUT_LINE");
    expect(logContent).toContain("STDERR_LINE");
  });

  it("kill() terminates a running process", async () => {
    const logFile = path.join(tmpDir, "kill.log");

    const handle = runner.spawn(
      "node",
      ["-e", "setTimeout(() => {}, 60000)"],
      { cwd: tmpDir, logFile },
    );

    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 100));

    runner.kill(handle.pid);

    const exitCode = await handle.exitCode;
    expect(exitCode).not.toBe(0);
  });
});
