import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Multi-process integration test for the `claude-orchestrator-claim` CLI.
 *
 * Unit tests in counter-store.test.ts and cli-claim.test.ts exercise the
 * primitive in-process. This test goes one level closer to production: it
 * spawns N concurrent `node dist/src/cli-claim.js` OS processes against a
 * shared counter dir and asserts every process gets a distinct number under
 * real lockfile contention. Parallel orchestrator sessions invoke the helper
 * exactly this way (one node process per agent invocation), so this is the
 * strongest "live" check available without spawning real Claude sessions.
 *
 * The test deliberately uses the built CLI in `dist/` so it also catches
 * build-time regressions — if the published bin is broken, this test fails.
 */

const cliPath = fileURLToPath(
  new URL("../../dist/src/cli-claim.js", import.meta.url),
);

interface ClaimRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  yamlPath: string,
  issue: number,
  domain: string,
): Promise<ClaimRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [
      cliPath,
      "--config",
      yamlPath,
      "--issue",
      String(issue),
      "--domain",
      domain,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code ?? -1, stdout, stderr }),
    );
  });
}

function writeYaml(tmpDir: string): string {
  // No git origin is configured; seedFromGit's fetch and ls-tree both fail
  // silently, so the first claim seeds to 1.
  const yaml = [
    "name: mp-test",
    "configDir: cfg",
    "worktreeDir: wt",
    "projectRoot: proj",
    "stallTimeout: 0",
    "sequentialDomains:",
    "  migrations:",
    "    paths:",
    '      - dir: migrations',
    '        pattern: "(\\\\d{4})_.*\\\\.sql"',
    "    width: 4",
    "issues: []",
    "",
  ].join("\n");
  const yamlPath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(yamlPath, yaml);
  fs.mkdirSync(path.join(tmpDir, "proj"), { recursive: true });
  return yamlPath;
}

describe("cli-claim multi-process (integration)", () => {
  let tmpDir: string;
  let yamlPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "orchestrator-claim-mp-"),
    );
    yamlPath = writeYaml(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands out distinct numbers under N concurrent OS-process invocations", async () => {
    const N = 10;
    const runs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runCli(yamlPath, i + 1, "migrations"),
      ),
    );

    for (const r of runs) {
      expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
    }
    const formatted = runs.map((r) => r.stdout.trim());
    const numbers = formatted.map((s) => parseInt(s, 10));

    expect(new Set(numbers).size).toBe(N);
    for (const s of formatted) {
      expect(s).toMatch(/^\d{4}$/);
    }
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    const counterFile = path.join(
      tmpDir,
      "cfg",
      "counters",
      "migrations.json",
    );
    const state = JSON.parse(fs.readFileSync(counterFile, "utf-8"));
    expect(Object.keys(state.claims).length).toBe(N);
    expect(state.next).toBe(N + 1);
    const lock = `${counterFile}.lock`;
    expect(fs.existsSync(lock)).toBe(false);
  }, 30_000);

  it("a retry of the same issue from a separate process reuses its number", async () => {
    const first = await runCli(yamlPath, 7, "migrations");
    expect(first.exitCode, `stderr=${first.stderr}`).toBe(0);
    const claimed = first.stdout.trim();

    const retry = await runCli(yamlPath, 7, "migrations");
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout.trim()).toBe(claimed);

    const next = await runCli(yamlPath, 8, "migrations");
    expect(next.exitCode).toBe(0);
    expect(parseInt(next.stdout.trim(), 10)).toBe(
      parseInt(claimed, 10) + 1,
    );
  }, 15_000);

  it("exits non-zero with a useful message on an unknown domain", async () => {
    const r = await runCli(yamlPath, 1, "nope");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown domain/);
  }, 10_000);
});
