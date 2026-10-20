import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliLeaseDeps,
  formatAdmitted,
  formatNoSlot,
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
import { scriptedLease, unwritableLeaseDir } from "./helpers/lease.js";

describe("lease messages", () => {
  const holder = (pid: number, command: string): HolderInfo => ({ id: `${pid}-ab`, pid, command, cwd: "/", startedAt: 0, level: "warning", ageSec: 1 });

  it("formats the admitted line exactly, rounding the wait to whole seconds", () => {
    expect(formatAdmitted({ waitedMs: 2_400, level: "warning", live: 1, capacity: 1 })).toBe("lease: admitted after 2s (pressure=warning, 1/1 live)");
  });

  it.each<[string, HolderInfo[], string]>([
    ["one holder", [holder(11, "npm test")], "1 live: 11 npm test"],
    ["several holders", [holder(11, "npm test"), holder(12, "tsc")], "2 live: 11 npm test, 12 tsc"],
    ["none", [], "0 live: none"],
  ])("formats the no-slot line exactly with %s", (_name, live, tail) => {
    const refusal: LeaseRefusal = { refused: "max-wait", waitedMs: 450_400, level: "warning", live: live.length };
    expect(formatNoSlot(refusal, { level: "warning", capacity: 1, step: 1, signals: null, live })).toBe(
      `lease: no slot after 450s (pressure=warning, capacity 1, ${tail}); rerun the command — this is not a test failure`,
    );
  });
});

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
  let handle: LeaseHandle & { release: ReturnType<typeof vi.fn>; setChildPid: ReturnType<typeof vi.fn> };
  let child: FakeChild;
  let spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[];
  let signals: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  let acquired: { meta: unknown; wait: { maxWaitMs?: number; onWait?(s: LeaseStatus & { waitedMs: number }): void } }[];
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
    leaseStatus: () => ({ level: "warning", capacity: 1, step: 1, signals: null, live: [holder()] }),
    ancestors: () => [],
    spawn: (file, args, o) => {
      spawned.push({ file, args, env: o.env });
      return child;
    },
    env,
    cwd: "/work",
    out: (t) => out.push(t),
    err: (l) => err.push(l),
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

  it("passes the weight of a matching rule to the holder meta in GiB bytes, and none without a match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-weights-"));
    try {
      writeFileSync(join(dir, "w.json"), '[{"pattern":"^npm test","gb":2}]');
      env = { ...env, CO_LEASE_WEIGHTS_FILE: join(dir, "w.json") };
      let done = run();
      await finishWith(0);
      await done;
      expect((acquired[0]!.meta as Record<string, unknown>).weight).toBe(2 * 2 ** 30);
      spawned = [];
      child = new FakeChild();
      done = run({ argv: ["make"] });
      await finishWith(0);
      await done;
      expect(acquired[1]!.meta).not.toHaveProperty("weight");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("exits 74 with the disk-full message, not the rerun line, and never runs the command", async () => {
    outcome = { refused: "disk-full", waitedMs: 0, level: "normal", live: 0, code: "ENOSPC" };
    expect(await run()).toBe(74);
    expect(err).toEqual(["lease: the disk is full (ENOSPC); free space before running heavy commands — do not rerun"]);
    expect(spawned).toEqual([]);
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
        acquire: (async (_o: LeaseOptions, _m: unknown, wait: { onWait?(s: LeaseStatus & { waitedMs: number }): void }) => {
          for (let waitedMs = 0; waitedMs <= 125_000; waitedMs += 5_000) wait.onWait?.({ level: "warning", capacity: 1, step: 1, signals: null, live: [holder()], waitedMs });
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
      const opts = scriptedLease(dir).opts();
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

  describe("borrowing the session's hook slot", () => {
    const SESSION = 4242;
    let dir: string;
    let lease: ReturnType<typeof scriptedLease>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cli-lease-hook-"));
      lease = scriptedLease(dir, { alive: [process.pid, SESSION] });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Plants a hook holder (detached, `expiresAt` set) owned by `pid`, then forgets the events planting it emitted. */
    const plantHook = async (pid: number, detached = true) => {
      const opts = lease.opts();
      const meta = { command: "npm test", cwd: "/w", ...(detached && { detached: { id: "hook-toolu_1", sessionPid: pid, expiresAt: lease.clock.ms + 60_000 } }) };
      await acquireLease(opts, meta);
      lease.events.length = 0;
    };
    const runWith = async (over: Partial<LeaseCliDeps>, opts: Partial<LeaseOptions> = {}) => {
      const done = run({}, { leaseOptions: () => lease.opts(opts), acquire: acquireLease, leaseStatus, ...over });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      child.emit("close", 0, null);
      return done;
    };

    it("borrows a hook holder whose session PID is an ancestor: says so, passes its id on, and emits no acquire or release", async () => {
      await plantHook(SESSION);
      expect(await runWith({ ancestors: () => [77, SESSION, 1] })).toBe(0);
      expect(err).toEqual(["lease: running inside this session's hook slot (hook-toolu_1)"]);
      expect(spawned[0]!.env.CO_LEASE_HOLDER).toBe("hook-toolu_1");
      expect(lease.events).toEqual([]);
    });

    it.each<[string, () => number[]]>([
      ["a holder whose session PID is not an ancestor", () => [77, 1]],
      ["an ancestor lookup that returns nothing", () => []],
      ["an ancestor lookup that throws", () => { throw new Error("ps failed"); }],
    ])("acquires normally past %s", async (_name, ancestors) => {
      await plantHook(SESSION);
      lease.alive.add(SESSION);
      const done = runWith({ ancestors }, { policy: { heavyCeiling: 2, heavyWarning: 2 } });
      expect(await done).toBe(0);
      expect(err[0]).toMatch(/^lease: admitted after /);
      expect(spawned[0]!.env.CO_LEASE_HOLDER).not.toBe("hook-toolu_1");
      expect(lease.events.map((e) => e.type)).toEqual(["acquire", "release"]);
    });

    it("does not borrow a holder without expiresAt, even when its PID is an ancestor", async () => {
      await plantHook(process.pid, false);
      expect(await runWith({ ancestors: () => [process.pid] }, { policy: { heavyCeiling: 2, heavyWarning: 2 } })).toBe(0);
      expect(err[0]).toMatch(/^lease: admitted after /);
    });

    it("does not look up ancestors when no hook holder is live", async () => {
      const ancestors = vi.fn(() => [SESSION]);
      expect(await runWith({ ancestors })).toBe(0);
      expect(ancestors).not.toHaveBeenCalled();
      expect(err[0]).toMatch(/^lease: admitted after /);
    });

    it("acquires normally, and says so, when the hook holder it found is gone by the time it acquires", async () => {
      const gone = { id: "hook-gone", pid: SESSION, command: "npm test", cwd: "/w", startedAt: lease.clock.ms, expiresAt: lease.clock.ms + 60_000, level: "normal" as const, ageSec: 0 };
      const status = (o: LeaseOptions) => ({ ...leaseStatus(o), live: [gone] });
      expect(await runWith({ ancestors: () => [SESSION], leaseStatus: status })).toBe(0);
      expect(err[0]).toMatch(/^lease: admitted after /);
      expect(spawned[0]!.env.CO_LEASE_HOLDER).not.toBe("hook-gone");
      expect(lease.events.map((e) => e.type)).toEqual(["acquire", "release"]);
    });

    it("does not look up ancestors when CO_LEASE_HOLDER names a live holder", async () => {
      await plantHook(SESSION);
      const ancestors = vi.fn(() => [SESSION]);
      expect(await runWith({ ancestors }, { inheritedHolderId: "hook-toolu_1" })).toBe(0);
      expect(ancestors).not.toHaveBeenCalled();
      expect(lease.events).toEqual([]);
    });
  });

  describe("front-end options (gated, background, suspendable)", () => {
    const meta = () => acquired[0]!.meta as Record<string, unknown>;
    const killed = () => signals.kill.mock.calls.map((c) => c.join(":"));

    it("marks the ticket gated and the holder suspendable", async () => {
      const done = run({ gated: true, suspendable: true });
      await finishWith(0);
      await done;
      expect(meta()).toMatchObject({ gated: true, suspendable: true });
    });

    it.each<[string, Partial<RunArgs>, NodeJS.ProcessEnv]>([
      ["--no-suspend", { noSuspend: true }, {}],
      ["HEAVY_QUEUE_NO_SUSPEND=1 in the injected env", {}, { HEAVY_QUEUE_NO_SUSPEND: "1" }],
    ])("is not suspendable under %s", async (_n, args, extra) => {
      const saved = process.env.HEAVY_QUEUE_NO_SUSPEND;
      process.env.HEAVY_QUEUE_NO_SUSPEND = extra.HEAVY_QUEUE_NO_SUSPEND === "1" ? "" : "1";
      try {
        const done = run({ suspendable: true, ...args }, { env: { ...env, ...extra } });
        await finishWith(0);
        await done;
        expect(meta().suspendable).toBeFalsy();
      } finally {
        if (saved === undefined) delete process.env.HEAVY_QUEUE_NO_SUSPEND;
        else process.env.HEAVY_QUEUE_NO_SUSPEND = saved;
      }
    });

    it.each([
      ["xcodebuild test -scheme App", { argv: ["xcodebuild", "test", "-scheme", "App"] }],
      ["xcrun simctl boot", { shell: "xcrun simctl boot iPhone" }],
      ["docker build", { argv: ["docker", "build", "."] }],
      ["podman run", { argv: ["/usr/local/bin/podman", "run", "x"] }],
      ["ssh host make", { shell: "cd x && ssh host make" }],
    ])("is not suspendable for the never-suspend command %s", async (_n, args) => {
      const done = run({ suspendable: true, argv: undefined, ...args });
      await finishWith(0);
      await done;
      expect(meta().suspendable).toBeFalsy();
    });

    it("keeps a command that only contains a never-suspend word in another word suspendable", async () => {
      const done = run({ suspendable: true, argv: ["npm", "run", "sshd-check"] });
      await finishWith(0);
      await done;
      expect(meta().suspendable).toBe(true);
    });

    it("leaves a plain run ungated, unsuspendable and in the caller's group", async () => {
      const done = run();
      await finishWith(0);
      await done;
      expect(meta()).toMatchObject({ gated: undefined, suspendable: undefined });
      expect(spawned[0]).toMatchObject({ file: "npm" });
    });

    it("spawns background through taskpolicy -b in its own group and records the pgid", async () => {
      let opts: { detached?: boolean } | undefined;
      const done = run({ background: true, argv: ["npm", "test"] }, {
        spawn: (f, a, o) => (spawned.push({ file: f, args: a, env: o.env }), (opts = o), child),
      });
      await finishWith(0);
      await done;
      expect(spawned[0]).toMatchObject({ file: "/usr/sbin/taskpolicy", args: ["-b", "npm", "test"] });
      expect(opts?.detached).toBe(true);
      expect(handle.setChildPid).toHaveBeenCalledExactlyOnceWith(4321, 4321);
    });

    it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("forwards %s to the background group after a SIGCONT", async (sig) => {
      const done = run({ background: true });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      signals.emit(sig);
      expect(killed()).toEqual(["-4321:SIGCONT", `-4321:${sig}`]);
      expect(child.kill).not.toHaveBeenCalled();
      child.emit("close", null, sig);
      await done;
    });

    it("does not borrow an ancestor hook slot, but honours an inherited holder", async () => {
      const ancestors = vi.fn(() => [1]);
      const live = { ...holder({ id: "hook-x", pid: 1 }), expiresAt: 1 };
      const status = () => ({ level: "normal" as const, capacity: 1, step: 1, signals: null, live: [live] });
      const seen: LeaseOptions[] = [];
      const acq = (async (o: LeaseOptions) => (seen.push(o), outcome)) as unknown as typeof acquireLease;
      const base = { ancestors, leaseStatus: status, acquire: acq };
      for (const args of [{ gated: true }, { background: true }, { suspendable: true }]) {
        const done = run(args, base);
        await finishWith(0);
        await done;
        spawned.length = 0;
      }
      expect(ancestors).not.toHaveBeenCalled();
      expect(seen.map((o) => o.inheritedHolderId)).toEqual([undefined, undefined, undefined]);
      const done = run({ gated: true }, { ...base, leaseOptions: () => ({ dir: "/lease", inheritedHolderId: "inh" }) as LeaseOptions });
      await finishWith(0);
      await done;
      expect(seen[3]!.inheritedHolderId).toBe("inh");
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
        leaseStatus: () => ({ level: "warning", capacity: 1, step: 1, signals: null, live: [holder(), holder({ pid: 12, command: "tsc", ageSec: 3, override: true })] }),
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

    it("adds weights beside live and capacity in weight mode, and leaves them out in count mode", () => {
      const weights = { used: 3 * 2 ** 30, budget: 9 * 2 ** 30 };
      const status = (extra: object) => deps({ leaseStatus: () => ({ level: "normal", capacity: 3, step: 3, signals: null, live: [holder()], ...extra }) });
      expect(runStatus(status({ weights }))).toBe(0);
      expect(JSON.parse(out.join(""))).toMatchObject({ capacity: 3, weights });
      out.length = 0;
      expect(runStatus(status({}))).toBe(0);
      expect(JSON.parse(out.join(""))).not.toHaveProperty("weights");
    });

    it("adds the unowned-memory breakdown, built from the live session holders' pids and the heavy holders' child pids, and leaves it out when it is unavailable", () => {
      const unowned = { simulators: 5, claude: 3, others: [] };
      const seen: number[][][] = [];
      const status = (u: typeof unowned | undefined) =>
        deps({
          leaseStatus: () => ({ level: "normal", capacity: 3, step: 3, signals: null, live: [holder(), holder({ childPid: 88 }), holder({ pid: 99, expiresAt: 1 })], sessions: { capacity: 6, live: [holder({ pid: 77 })] } }),
          unowned: (_opts: LeaseOptions, pids: number[], heavyChildPids: number[]) => (seen.push([pids, heavyChildPids]), u),
        });
      expect(runStatus(status(unowned))).toBe(0);
      expect(JSON.parse(out.join(""))).toMatchObject({ unowned });
      expect(seen).toEqual([[[77], [88, 99]]]);
      out.length = 0;
      expect(runStatus(status(undefined))).toBe(0);
      expect(JSON.parse(out.join(""))).not.toHaveProperty("unowned");
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
