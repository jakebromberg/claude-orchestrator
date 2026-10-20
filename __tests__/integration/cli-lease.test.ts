import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isolatedLeaseEnv } from "../helpers/lease.js";

/**
 * Integration test for the `claude-orchestrator-lease` CLI, against the built
 * `dist/`. Every process runs in a fresh mkdtemp lease directory with capacity
 * pinned to 1 at every pressure level (`CO_LEASE_SLOTS=1` plus
 * `CO_PRESSURE_OVERRIDE=critical-as-warning`), so nothing touches the
 * machine's real lease directory.
 */

const cliPath = fileURLToPath(new URL("../../dist/src/cli-lease.js", import.meta.url));

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    execFile("node", [cliPath, ...args], { env }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: (err?.code as number | undefined) ?? 0, stdout, stderr });
    });
  });
}

/** The first holder record that has recorded its child PID. */
function holderWithChild(leaseDir: string): { childPid: number } | undefined {
  for (const file of holderFiles(leaseDir)) {
    const rec = JSON.parse(fs.readFileSync(path.join(leaseDir, "holders", file), "utf8"));
    if (rec.childPid) return rec;
  }
  return undefined;
}

const holderFiles = (leaseDir: string): string[] => {
  try {
    return fs.readdirSync(path.join(leaseDir, "holders")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("claude-orchestrator-lease (integration)", () => {
  let tmpDir: string;
  let leaseDir: string;
  let childPids: number[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lease-cli-"));
    leaseDir = path.join(tmpDir, "lease");
    childPids = [];
  });
  afterEach(() => {
    for (const pid of childPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes the exit code through, prints the admitted line and releases the slot", async () => {
    const r = await runCli(["--", "node", "-e", "process.exit(7)"], isolatedLeaseEnv(leaseDir));
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/^lease: admitted after 0s \(pressure=\w+, 1\/1 live(, weights [\d.]+\/[\d.]+ GB)?\)$/m);
    expect(holderFiles(leaseDir)).toEqual([]);
  });

  it("runs --shell under /bin/sh with the parent's variables and CO_LEASE_HOLDER", async () => {
    const r = await runCli(
      ["--shell", 'echo "$PARENT_ONLY $CO_LEASE_HOLDER"; status=3; exit $status'],
      isolatedLeaseEnv(leaseDir, { PARENT_ONLY: "from-parent", SHELL: "/bin/zsh" }),
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/^from-parent \d+-[0-9a-f]{8}\n$/);
  });

  it("reports holders from status without creating the lease directory", async () => {
    const r = await runCli(["status"], isolatedLeaseEnv(leaseDir));
    expect(r.code).toBe(0);
    const status = JSON.parse(r.stdout);
    // `unowned` comes from the real `ps`, so its numbers vary by machine; pin only its shape.
    const { unowned, ...rest } = status;
    expect(rest).toEqual({ level: expect.any(String), capacity: 1, live: [], ...(status.weights && { weights: expect.any(Object) }) });
    if (unowned !== undefined) {
      expect(unowned).toEqual({ simulators: expect.any(Number), claude: expect.any(Number), others: expect.any(Array) });
    }
    expect(fs.existsSync(leaseDir)).toBe(false);
  });

  it("exits 78 naming CO_LEASE_DIR for a relative directory, in the run form and in status", async () => {
    const env = isolatedLeaseEnv("relative/dir");
    for (const args of [["--", "node", "-e", "process.exit(0)"], ["status"]]) {
      const r = await runCli(args, env);
      expect(r.code).toBe(78);
      expect(r.stderr).toMatch(/^lease: .*CO_LEASE_DIR.*\n$/);
      expect(r.stdout).toBe("");
    }
  });

  // Node throws from spawn() for these rather than emitting 'error'. Linux's execvp runs a script with no `#!` line under
  // /bin/sh, so only macOS's posix_spawn fails it (ENOEXEC).
  const cannotStart: [string, number, (dir: string) => string][] = [
    ["an empty program name", 127, () => ""],
    ["a path through a regular file (ENOTDIR)", 126, (dir) => (fs.writeFileSync(path.join(dir, "file"), ""), path.join(dir, "file", "x"))],
  ];
  if (process.platform === "darwin") {
    cannotStart.push(["an executable with no #! line (ENOEXEC)", 126, (dir) => (fs.writeFileSync(path.join(dir, "ci.sh"), "exit 0\n", { mode: 0o755 }), path.join(dir, "ci.sh"))]);
  }
  it.each(cannotStart)("exits %s with %i and releases the slot when spawn throws", async (_name, expected, program) => {
    const env = isolatedLeaseEnv(leaseDir);
    const r = await runCli(["--", program(tmpDir)], env);
    expect(r.code).toBe(expected);
    expect(r.stderr).toMatch(/^lease: admitted after/m);
    expect(r.stderr).toMatch(/^lease: cannot run /m);
    expect(holderFiles(leaseDir)).toEqual([]);
    expect(JSON.parse((await runCli(["status"], env)).stdout).live).toEqual([]);
  });

  it("dies of a signal that arrives while it waits for a slot, and holds nothing", async () => {
    const env = isolatedLeaseEnv(leaseDir);
    const first = spawn("node", [cliPath, "--", "node", "-e", "setTimeout(() => {}, 60000)"], { env, stdio: "ignore" });
    childPids.push(first.pid!);
    childPids.push((await until(() => holderWithChild(leaseDir), "the first holder to record its child PID")).childPid);

    // An invalid CO_LEASE_MAX_WAIT (and no --max-wait) makes the CLI print one line just before it installs the
    // forwarders and starts waiting; that line is the readiness signal. The wait falls back to the 100 s default.
    const waiter = spawn("node", [cliPath, "--", "node", "-e", "process.exit(0)"], {
      env: { ...env, CO_LEASE_MAX_WAIT: "not-a-number" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    childPids.push(waiter.pid!);
    let stderr = "";
    waiter.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => waiter.once("exit", (_code, signal) => resolve(signal)));
    await until(() => (stderr.includes("CO_LEASE_MAX_WAIT") ? true : undefined), "the waiter to start waiting");
    await new Promise((r) => setTimeout(r, 300));
    waiter.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    expect(holderFiles(leaseDir)).toHaveLength(1);
  }, 30_000);

  it("forwards SIGTERM to the child, exits 143 and releases the slot", async () => {
    const wrapper = spawn("node", [cliPath, "--", "node", "-e", "setTimeout(() => {}, 60000)"], { env: isolatedLeaseEnv(leaseDir), stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => wrapper.once("exit", (code) => resolve(code)));
    await until(() => holderWithChild(leaseDir), "the holder to record its child PID");
    wrapper.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(holderFiles(leaseDir)).toEqual([]);
  }, 30_000);

  it("keeps the slot when the wrapper is SIGKILLed while its child lives, and frees it when the child dies", async () => {
    const env = isolatedLeaseEnv(leaseDir);
    const wrapper = spawn("node", [cliPath, "--label", "long job", "--", "node", "-e", "setTimeout(() => {}, 60000)"], {
      env,
      stdio: "ignore",
    });
    const wrapperExit = new Promise<void>((resolve) => wrapper.once("exit", () => resolve()));
    const rec = await until(() => holderWithChild(leaseDir), "the holder to record its child PID");
    childPids.push(rec.childPid);

    wrapper.kill("SIGKILL");
    await wrapperExit;
    // The dead wrapper no longer beats, so age the heartbeat past its 90 s window: only the live child holds the slot now.
    const holderPath = path.join(leaseDir, "holders", holderFiles(leaseDir)[0]!);
    const aged = (Date.now() - 5 * 60_000) / 1000;
    fs.utimesSync(holderPath, aged, aged);

    const status = JSON.parse((await runCli(["status"], env)).stdout);
    expect(status.live).toEqual([{ pid: wrapper.pid, command: "long job", ageSec: expect.any(Number) }]);
    const busy = await runCli(["--max-wait", "0", "--", "node", "-e", "process.exit(0)"], env);
    expect(busy.code).toBe(75);
    expect(busy.stderr).toContain("lease: no slot after 0s");
    expect(busy.stderr).toContain("rerun the command — this is not a test failure");

    process.kill(rec.childPid, "SIGKILL");
    const freed = () => (JSON.parse(execFileSync("node", [cliPath, "status"], { env, encoding: "utf8" })).live.length === 0 ? true : undefined);
    await until(freed, "the slot to free");
  }, 30_000);
});
