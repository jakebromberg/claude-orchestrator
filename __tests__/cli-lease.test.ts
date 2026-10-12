import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliLeaseDeps,
  parseLeaseArgs,
  runLeased,
  runStatus,
  type LeaseCliDeps,
  type RunArgs,
} from "../src/cli-lease.js";
import {
  acquireLease,
  defaultLeaseOptions,
  leaseStatus,
  type HolderInfo,
  type LeaseHandle,
  type LeaseOptions,
  type LeaseRefusal,
  type LeaseStatus,
} from "../src/lease.js";
import { scriptedPressureSampler } from "../src/testing.js";
import { unwritableLeaseDir } from "./helpers/lease.js";

describe("parseLeaseArgs", () => {
  it.each<[string, string[], unknown]>([
    ["argv after --", ["--", "npm", "test"], { kind: "run", argv: ["npm", "test"] }],
    ["flags before --", ["--max-wait", "5", "--label", "ci", "--", "npm", "test"], { kind: "run", maxWaitSec: 5, label: "ci", argv: ["npm", "test"] }],
    ["a second -- belongs to the command", ["--", "npm", "test", "--", "--bail"], { kind: "run", argv: ["npm", "test", "--", "--bail"] }],
    ["--shell", ["--shell", "a && b"], { kind: "run", shell: "a && b" }],
    ["--max-wait 0", ["--max-wait", "0", "--shell", "true"], { kind: "run", maxWaitSec: 0, shell: "true" }],
    ["status", ["status"], { kind: "status" }],
  ])("parses %s", (_name, argv, expected) => {
    expect(parseLeaseArgs(argv)).toEqual(expected);
  });

  it.each<[string, string[], RegExp]>([
    ["no command", [], /command is required/],
    ["nothing after --", ["--"], /no command after --/],
    ["an empty --shell", ["--shell", ""], /--shell requires/],
    ["--shell that is not last", ["--shell", "true", "--label", "x"], /--shell must be the last/],
    ["a missing --max-wait value", ["--max-wait"], /--max-wait requires/],
    ["a non-numeric --max-wait", ["--max-wait", "soon", "--", "x"], /--max-wait must be/],
    ["a negative --max-wait", ["--max-wait", "-1", "--", "x"], /--max-wait must be/],
    ["a repeated --label", ["--label", "a", "--label", "b", "--", "x"], /--label given more than once/],
    ["an unknown flag", ["--bogus", "--", "x"], /Unknown argument: --bogus/],
    ["an unknown subcommand", ["bogus"], /Unknown subcommand: bogus/],
    ["arguments after status", ["status", "now"], /status takes no arguments/],
  ])("rejects %s", (_name, argv, message) => {
    expect(() => parseLeaseArgs(argv)).toThrow(message);
  });
});

class FakeChild extends EventEmitter {
  kill = vi.fn((_sig?: NodeJS.Signals) => true);
  pid: number | undefined = 4321;
}

const holder = (over: Partial<HolderInfo> = {}): HolderInfo => ({
  id: "1-aa", pid: 11, command: "npm test", cwd: "/w", startedAt: 0, level: "normal", ageSec: 7, ...over,
});

describe("runLeased", () => {
  let err: string[];
  let out: string[];
  let clock: number;
  let handle: LeaseHandle & { release: ReturnType<typeof vi.fn>; setChildPid: ReturnType<typeof vi.fn> };
  let child: FakeChild;
  let spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[];
  let signals: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  let acquired: { meta: unknown; wait: { maxWaitMs?: number; onWait?(s: LeaseStatus): void } }[];
  let outcome: LeaseHandle | LeaseRefusal;
  let env: NodeJS.ProcessEnv;

  const makeHandle = (over: Partial<LeaseHandle> = {}) =>
    ({
      id: "1-aa",
      leased: true,
      admission: { waitedMs: 2400, level: "warning", live: 1, capacity: 1 },
      childEnv: () => ({ CO_LEASE_HOLDER: "1-aa" }),
      setChildPid: vi.fn(),
      release: vi.fn(),
      ...over,
    }) as LeaseHandle & { release: ReturnType<typeof vi.fn>; setChildPid: ReturnType<typeof vi.fn> };

  const deps = (over: Partial<LeaseCliDeps> = {}): LeaseCliDeps => ({
    leaseOptions: () => ({ dir: "/lease" }) as LeaseOptions,
    acquire: (async (_opts: LeaseOptions, meta: unknown, wait: never) => {
      acquired.push({ meta, wait });
      return outcome;
    }) as unknown as typeof acquireLease,
    leaseStatus: () => ({ level: "warning", capacity: 1, live: [holder()] }),
    spawn: (file, args, o) => {
      spawned.push({ file, args, env: o.env });
      return child;
    },
    env,
    cwd: "/work",
    out: (t) => out.push(t),
    err: (l) => err.push(l),
    now: () => clock,
    signals,
    ...over,
  });

  const run = (args: Partial<RunArgs> = {}, over: Partial<LeaseCliDeps> = {}) =>
    runLeased({ kind: "run", argv: ["npm", "test"], ...args }, deps(over));
  const forwarders = () => (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => signals.listenerCount(s));
  /** Lets `runLeased` get through `await acquire` and spawn, then ends the child. */
  const finishWith = async (code: number | null, signal: NodeJS.Signals | null = null) => {
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    child.emit("close", code, signal);
  };

  beforeEach(() => {
    err = [];
    out = [];
    clock = 0;
    handle = makeHandle();
    outcome = handle;
    child = new FakeChild();
    spawned = [];
    acquired = [];
    signals = Object.assign(new EventEmitter(), { pid: 999, kill: vi.fn() });
    env = { PARENT_ONLY: "1", SHELL: "/bin/zsh" };
  });

  it.each([0, 3, 255])("passes exit code %i through, prints the admitted line and releases with it", async (code) => {
    const done = run();
    await finishWith(code);
    expect(await done).toBe(code);
    expect(err).toEqual(["lease: admitted after 2s (pressure=warning, 1/1 live)"]);
    expect(handle.release).toHaveBeenCalledWith({ exitCode: code });
  });

  it("spawns an argv command directly with the parent env plus CO_LEASE_HOLDER", async () => {
    const done = run({ argv: ["npm", "test", "--", "--bail"] });
    await finishWith(0);
    await done;
    expect(spawned).toEqual([
      { file: "npm", args: ["test", "--", "--bail"], env: { PARENT_ONLY: "1", SHELL: "/bin/zsh", CO_LEASE_HOLDER: "1-aa" } },
    ]);
    expect(env).not.toHaveProperty("CO_LEASE_HOLDER");
  });

  it("runs --shell under /bin/sh -c, never $SHELL", async () => {
    const done = run({ argv: undefined, shell: "status=1; exit $status" });
    await finishWith(0);
    await done;
    expect(spawned[0]).toMatchObject({ file: "/bin/sh", args: ["-c", "status=1; exit $status"] });
  });

  it("records the child PID synchronously after spawn, before any microtask runs", async () => {
    let recordedBeforeMicrotask: number | undefined;
    const done = run({}, {
      spawn: () => {
        queueMicrotask(() => (recordedBeforeMicrotask = handle.setChildPid.mock.calls.length));
        return child;
      },
    });
    await vi.waitFor(() => expect(recordedBeforeMicrotask).toBeDefined());
    expect(recordedBeforeMicrotask).toBe(1);
    expect(handle.setChildPid).toHaveBeenCalledExactlyOnceWith(4321);
    child.emit("close", 0, null);
    await done;
  });

  it("kills the child and releases when setChildPid throws", async () => {
    handle.setChildPid.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(await run()).toBe(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(handle.release).toHaveBeenCalledExactlyOnceWith({ exitCode: 1 });
    expect(err.join("\n")).toContain("disk full");
  });

  it("hints at shell functions when a --shell child exits 127, but not an argv child", async () => {
    const hint = "lease: command not found inside the wrapper; shell functions and aliases are not available under --shell";
    let done = run({ argv: undefined, shell: "myfn" });
    await finishWith(127);
    expect(await done).toBe(127);
    expect(err).toContain(hint);

    err = [];
    spawned = [];
    done = run();
    await finishWith(127);
    await done;
    expect(err).not.toContain(hint);
  });

  it.each<[string, string, number]>([
    ["a missing program", "ENOENT", 127],
    ["a program it may not execute", "EACCES", 126],
  ])("reports a spawn 'error' for %s as %s -> %i, and releases once although 'close' follows", async (_name, code, exit) => {
    child.pid = undefined;
    const done = run({ argv: ["nope"] });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    child.emit("error", Object.assign(new Error(`spawn nope ${code}`), { code }));
    child.emit("close", -2, null);
    expect(await done).toBe(exit);
    expect(err).toContain(`lease: cannot run nope: spawn nope ${code}`);
    expect(handle.setChildPid).not.toHaveBeenCalled();
    expect(handle.release).toHaveBeenCalledExactlyOnceWith({ exitCode: exit });
  });

  it.each<[string, string, string, number]>([
    ["a shebang-less executable", "./ci.sh", "ENOEXEC", 126],
    ["a path through a regular file", "/etc/passwd/x", "ENOTDIR", 126],
    ["an empty program name", "", "ERR_INVALID_ARG_VALUE", 127],
  ])("reports a spawn that throws for %s (program %j, %s) as %i, and releases once", async (_name, program, code, exit) => {
    const thrown = Object.assign(new Error(`spawn ${code}`), { code });
    const done = run({ argv: [program, "--flag"] }, {
      spawn: () => {
        throw thrown;
      },
    });
    expect(await done).toBe(exit);
    expect(err).toContain(`lease: cannot run ${program}: spawn ${code}`);
    expect(handle.release).toHaveBeenCalledExactlyOnceWith({ exitCode: exit });
    expect(handle.setChildPid).not.toHaveBeenCalled();
    expect(forwarders()).toEqual([0, 0, 0]);
  });

  it("exits 128+n when the child dies of a signal on its own", async () => {
    const done = run();
    await finishWith(null, "SIGKILL");
    expect(await done).toBe(137);
  });

  it("runs an unleased (fail-open) handle without an admitted line", async () => {
    outcome = makeHandle({ id: null, leased: false, childEnv: () => ({}) });
    const done = run();
    await finishWith(0);
    expect(await done).toBe(0);
    expect(err).toEqual([]);
    expect(spawned[0]!.env).not.toHaveProperty("CO_LEASE_HOLDER");
  });

  describe("the wait cap", () => {
    it("exits 75 with the no-slot message and never runs the command", async () => {
      outcome = { refused: "max-wait", waitedMs: 100_400, level: "warning", live: 1 };
      expect(await run()).toBe(75);
      expect(err).toEqual([
        "lease: no slot after 100s (pressure=warning, capacity 1, 1 live: 11 npm test); rerun the command — this is not a test failure",
      ]);
      expect(spawned).toEqual([]);
    });

    it.each<[string, number | undefined, string | undefined, number]>([
      ["the flag beats the env", 5, "50", 5000],
      ["the env beats the default", undefined, "50", 50_000],
      ["the default is 100 s", undefined, undefined, 100_000],
      ["0 means do not wait", 0, "50", 0],
    ])("precedence: %s", async (_name, flag, envValue, expectedMs) => {
      env = envValue === undefined ? {} : { CO_LEASE_MAX_WAIT: envValue };
      const done = run({ maxWaitSec: flag });
      await finishWith(0);
      await done;
      expect(acquired[0]!.wait.maxWaitMs).toBe(expectedMs);
    });

    it.each<[string, string, number | undefined, string[], number]>([
      ["notes an invalid value it falls back from", "soon", undefined, ['lease: ignoring invalid CO_LEASE_MAX_WAIT="soon"; using 100s'], 100_000],
      ["says nothing of an invalid value that --max-wait overrides", "soon", 2, [], 2000],
      ["treats an empty value as unset", "", undefined, [], 100_000],
    ])("CO_LEASE_MAX_WAIT: %s", async (_name, envValue, flag, notes, expectedMs) => {
      env = { CO_LEASE_MAX_WAIT: envValue };
      const done = run({ maxWaitSec: flag });
      await finishWith(0);
      await done;
      expect(acquired[0]!.wait.maxWaitMs).toBe(expectedMs);
      expect(err.filter((l) => l.includes("CO_LEASE_MAX_WAIT"))).toEqual(notes);
    });

    it("prints one progress line per minute while waiting", async () => {
      const waiting = deps({
        acquire: (async (_o: LeaseOptions, _m: unknown, wait: { onWait?(s: LeaseStatus): void }) => {
          for (clock = 0; clock <= 125_000; clock += 5_000) wait.onWait?.({ level: "warning", capacity: 1, live: [holder()] });
          return handle;
        }) as unknown as typeof acquireLease,
      });
      const done = runLeased({ kind: "run", argv: ["x"] }, waiting);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      child.emit("close", 0, null);
      await done;
      expect(err.filter((l) => l.includes("waiting"))).toEqual([
        "lease: waiting 60s for a slot (pressure=warning, 1/1 live)",
        "lease: waiting 120s for a slot (pressure=warning, 1/1 live)",
      ]);
    });
  });

  describe("signals", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each<[NodeJS.Signals, number]>([["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]])(
      "forwards %s and exits 128+n once the child exits within the grace period",
      async (sig, n) => {
        const done = run();
        await vi.waitFor(() => expect(spawned).toHaveLength(1));
        signals.emit(sig);
        expect(child.kill).toHaveBeenCalledWith(sig);
        child.emit("close", 0, null);
        expect(await done).toBe(128 + n);
        expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
        vi.advanceTimersByTime(20_000);
        expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
        for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(signals.listenerCount(s)).toBe(0);
      },
    );

    it("SIGKILLs the child after 10 s, releases the slot and exits 128+n", async () => {
      const done = run();
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      signals.emit("SIGTERM");
      vi.advanceTimersByTime(9_999);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
      vi.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(await done).toBe(143);
      child.emit("close", null, "SIGKILL");
      expect(handle.release).toHaveBeenCalledExactlyOnceWith({ exitCode: 143 });
    });

    it("keeps the first signal's exit code and its one grace timer when a second signal arrives", async () => {
      const done = run();
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      const sigkills = () => child.kill.mock.calls.filter(([s]) => s === "SIGKILL").length;
      signals.emit("SIGINT");
      vi.advanceTimersByTime(5_000);
      signals.emit("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(4_999);
      expect(sigkills()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(await done).toBe(130);
      vi.advanceTimersByTime(20_000);
      expect(sigkills()).toBe(1);
      expect(handle.release).toHaveBeenCalledExactlyOnceWith({ exitCode: 130 });
    });

    it("installs the forwarders before acquiring, so no signal finds the wrapper unguarded between admission and spawn", async () => {
      let atAcquire: number[] = [];
      const done = run({}, {
        acquire: (async () => {
          atAcquire = forwarders();
          return handle;
        }) as unknown as typeof acquireLease,
        spawn: () => child,
      });
      await vi.waitFor(() => expect(handle.setChildPid).toHaveBeenCalled());
      expect(atAcquire).toEqual([1, 1, 1]);
      child.emit("close", 0, null);
      expect(await done).toBe(0);
    });

    it("re-raises a signal that arrives while it waits on its own PID, after removing the forwarders", async () => {
      let refuse!: (outcome: LeaseRefusal) => void;
      const listening: number[][] = [];
      signals.kill.mockImplementation(() => listening.push(forwarders()));
      const done = run({}, { acquire: (() => new Promise((r) => (refuse = r))) as unknown as typeof acquireLease });
      signals.emit("SIGTERM");
      expect(signals.kill).toHaveBeenCalledExactlyOnceWith(999, "SIGTERM");
      expect(listening).toEqual([[0, 0, 0]]);
      refuse({ refused: "max-wait", waitedMs: 0, level: "warning", live: 1 });
      expect(await done).toBe(75);
    });
  });

  describe("recording", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cli-lease-unit-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const realLease = (): Partial<LeaseCliDeps> => {
      const opts: LeaseOptions = {
        dir,
        level: scriptedPressureSampler("normal"),
        policy: { heavyCeiling: 1, heavyWarning: 1 },
      };
      return {
        leaseOptions: () => opts,
        acquire: acquireLease,
        leaseStatus,
        spawn: (_f, _a, _o) => child,
      };
    };

    it.each<[string, Partial<RunArgs>, string]>([
      ["the label verbatim", { label: "ci: unit tests", argv: undefined, shell: "TOKEN=abc npm test" }, "ci: unit tests"],
      ["the command up to its first =", { argv: undefined, shell: "TOKEN=abc npm test" }, "TOKEN=…"],
      ["the argv joined", { argv: ["npm", "test"] }, "npm test"],
    ])("records %s in the holder", async (_name, args, recorded) => {
      const over = realLease();
      let seen: string | undefined;
      over.spawn = () => {
        seen = leaseStatus(over.leaseOptions!()).live[0]?.command;
        return child;
      };
      const done = run(args, over);
      await vi.waitFor(() => expect(seen).toBeDefined());
      child.emit("close", 0, null);
      await done;
      expect(seen).toBe(recorded);
    });
  });

  describe("a configuration error", () => {
    it("exits 78 naming CO_LEASE_DIR, without acquiring or running", async () => {
      const bad = { leaseOptions: () => defaultLeaseOptions({ CO_LEASE_DIR: "relative/dir" }) };
      expect(await run({}, bad)).toBe(78);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^lease: .*CO_LEASE_DIR/);
      expect(acquired).toEqual([]);
      expect(spawned).toEqual([]);
    });

    it("exits 78 from status as well", () => {
      const bad = { leaseOptions: () => defaultLeaseOptions({ CO_LEASE_DIR: "relative/dir" }) };
      expect(runStatus(deps(bad))).toBe(78);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^lease: .*CO_LEASE_DIR/);
      expect(out).toEqual([]);
    });
  });

  describe("status", () => {
    it("prints level, capacity and live holders as pid/command/ageSec, plus override when set", () => {
      const status = deps({
        leaseStatus: () => ({ level: "warning", capacity: 1, live: [holder(), holder({ pid: 12, command: "tsc", ageSec: 3, override: true })] }),
      });
      expect(runStatus(status)).toBe(0);
      expect(JSON.parse(out.join(""))).toEqual({
        level: "warning",
        capacity: 1,
        live: [
          { pid: 11, command: "npm test", ageSec: 7 },
          { pid: 12, command: "tsc", ageSec: 3, override: true },
        ],
      });
    });

    it("creates nothing on disk", () => {
      const tmp = mkdtempSync(join(tmpdir(), "cli-lease-status-"));
      const dir = join(tmp, "lease");
      try {
        const real = deps({
          leaseOptions: () => ({
            dir,
            level: scriptedPressureSampler("normal"),
            policy: { heavyCeiling: 2, heavyWarning: 1 },
          }),
          leaseStatus,
        });
        expect(runStatus(real)).toBe(0);
        expect(JSON.parse(out.join(""))).toEqual({ level: "normal", capacity: 2, live: [] });
        expect(existsSync(dir)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("package bin", () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

  it("declares claude-orchestrator-lease, and package-lock.json's root bin agrees with package.json", () => {
    const pkg = read("package.json");
    expect(pkg.bin["claude-orchestrator-lease"]).toBe("dist/src/cli-lease.js");
    expect(read("package-lock.json").packages[""].bin).toEqual(pkg.bin);
  });
});

describe("cliLeaseDeps (the wiring main uses)", () => {
  it("routes the lease's fail-open warning through err, not stderr", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cli-lease-"));
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const env = { CO_LEASE_DIR: unwritableLeaseDir(tmp), CO_LEASE_SLOTS: "many", HOME: tmp };
      const lines: string[] = [];
      const opts = cliLeaseDeps((l) => lines.push(l), { env, level: scriptedPressureSampler("normal") }).leaseOptions();
      ((await acquireLease(opts, { command: "npm test", cwd: "/w" })) as LeaseHandle).release();
      expect(lines).toEqual([
        'memory-pressure: ignoring invalid CO_LEASE_SLOTS="many"; keeping 4',
        "lease: unavailable (io-error); running unleased",
      ]);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
