import { describe, it, expect, beforeEach } from "vitest";
import { ProcessPool } from "../src/process-pool.js";
import type { ProcessHandle, ProcessRunner } from "../src/types.js";

function createMockRunner(): ProcessRunner & {
  spawned: Array<{ command: string; args: string[]; options: { cwd: string; logFile: string } }>;
  resolvers: Map<number, (code: number) => void>;
  nextPid: number;
} {
  let nextPid = 100;
  const resolvers = new Map<number, (code: number) => void>();
  const spawned: Array<{
    command: string;
    args: string[];
    options: { cwd: string; logFile: string };
  }> = [];

  return {
    spawned,
    resolvers,
    get nextPid() {
      return nextPid;
    },
    set nextPid(v) {
      nextPid = v;
    },
    spawn(command, args, options) {
      const pid = nextPid++;
      spawned.push({ command, args, options });
      let resolve!: (code: number) => void;
      const exitCode = new Promise<number>((r) => {
        resolve = r;
      });
      resolvers.set(pid, resolve);
      return { pid, issueNumber: 0, exitCode };
    },
    kill(pid: number) {
      const resolve = resolvers.get(pid);
      if (resolve) resolve(137);
    },
  };
}

describe("ProcessPool", () => {
  let runner: ReturnType<typeof createMockRunner>;

  beforeEach(() => {
    runner = createMockRunner();
  });

  it("launches up to maxParallel processes concurrently", async () => {
    const pool = new ProcessPool(2);
    const handles: ProcessHandle[] = [];

    handles.push(runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" }));
    handles.push(runner.spawn("cmd", [], { cwd: "/b", logFile: "/b.log" }));

    pool.add(handles[0]);
    pool.add(handles[1]);

    expect(pool.activeCount).toBe(2);
    expect(pool.isFull).toBe(true);
  });

  it("reports not full when below limit", () => {
    const pool = new ProcessPool(3);
    const h = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
    pool.add(h);

    expect(pool.activeCount).toBe(1);
    expect(pool.isFull).toBe(false);
  });

  it("removes a process from pool when it finishes", async () => {
    const pool = new ProcessPool(2);
    const h = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
    pool.add(h);

    expect(pool.activeCount).toBe(1);

    // Resolve the process
    runner.resolvers.get(h.pid)!(0);

    // waitForSlot should resolve now
    await pool.waitForSlot();
    expect(pool.activeCount).toBe(0);
  });

  it("waitAll resolves when all processes complete", async () => {
    const pool = new ProcessPool(4);

    const h1 = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
    const h2 = runner.spawn("cmd", [], { cwd: "/b", logFile: "/b.log" });
    pool.add(h1);
    pool.add(h2);

    // Resolve both
    runner.resolvers.get(h1.pid)!(0);
    runner.resolvers.get(h2.pid)!(0);

    const results = await pool.waitAll();
    expect(results).toEqual([
      { pid: h1.pid, issueNumber: h1.issueNumber, exitCode: 0 },
      { pid: h2.pid, issueNumber: h2.issueNumber, exitCode: 0 },
    ]);
  });

  it("tracks PIDs and issue numbers", () => {
    const pool = new ProcessPool(4);
    const h: ProcessHandle = {
      pid: 42,
      issueNumber: 7,
      exitCode: new Promise(() => {}),
    };
    pool.add(h);

    expect(pool.activePids).toEqual([42]);
  });

  it("waitForSlot resolves immediately when pool is not full", async () => {
    const pool = new ProcessPool(4);
    // Should resolve without blocking
    await pool.waitForSlot();
  });

  it("collects exit codes from completed processes", async () => {
    const pool = new ProcessPool(4);
    const h1 = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
    h1.issueNumber = 1;
    const h2 = runner.spawn("cmd", [], { cwd: "/b", logFile: "/b.log" });
    h2.issueNumber = 2;

    pool.add(h1);
    pool.add(h2);

    runner.resolvers.get(h1.pid)!(0);
    runner.resolvers.get(h2.pid)!(1);

    const results = await pool.waitAll();
    expect(results[0].exitCode).toBe(0);
    expect(results[1].exitCode).toBe(1);
  });

  describe("setMaxParallel", () => {
    it("reduces concurrency threshold", () => {
      const pool = new ProcessPool(4);
      pool.setMaxParallel(1);

      const h = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
      pool.add(h);

      expect(pool.isFull).toBe(true);
    });

    it("takes effect mid-execution without killing active processes", () => {
      const pool = new ProcessPool(4);
      const h1 = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
      const h2 = runner.spawn("cmd", [], { cwd: "/b", logFile: "/b.log" });
      pool.add(h1);
      pool.add(h2);

      expect(pool.isFull).toBe(false);

      pool.setMaxParallel(1);

      // Pool is now over capacity but active processes are not killed
      expect(pool.activeCount).toBe(2);
      expect(pool.isFull).toBe(true);
    });

    it("blocks waitForSlot when at reduced capacity", async () => {
      const pool = new ProcessPool(4);
      const h = runner.spawn("cmd", [], { cwd: "/a", logFile: "/a.log" });
      pool.add(h);

      pool.setMaxParallel(1);

      // waitForSlot should block because pool is full (1 active >= 1 max)
      let resolved = false;
      const waitPromise = pool.waitForSlot().then(() => { resolved = true; });

      // Give microtasks a chance to run
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Resolve the active process to unblock
      runner.resolvers.get(h.pid)!(0);
      await waitPromise;
      expect(resolved).toBe(true);
    });
  });
});
