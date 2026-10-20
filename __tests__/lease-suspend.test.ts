import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLeased, type LeaseCliDeps } from "../src/cli-lease.js";
import { acquireLease, acquireSessionLease, SUSPEND_MIN_RUN_MS, suspendNewest, tryAcquireLease, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { readSuspensions, writeSuspension, type SuspensionRecord } from "../src/suspensions.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { failFsCall, plantCpu, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const WIDE = { heavyCeiling: 4, heavyWarning: 4 };
const TICKS = { idle: 1, total: 10 };
const SECOND = 1000;

describe("suspending the newest suspendable holder", () => {
  let dir: string;
  let lease: ScriptedLease;
  let step: number;
  let freePct: number | undefined;
  let stop: ReturnType<typeof vi.fn>;
  let handles: Record<string, LeaseHandle>;
  const pgid = { a: 9001, b: 9002, c: 9003 };

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions =>
    lease.opts({
      policy: WIDE,
      cpuTimes: () => TICKS,
      headroom: scriptedHeadroomSampler(() => ({ level: step === 0 ? "critical" : "normal", step, signals: freePct === undefined ? null : { level: "normal", freePct } })),
      ...over,
    });
  const advance = (ms: number): void => void (lease.clock.ms += ms);
  const holderRec = (name: string) => JSON.parse(readFileSync(join(dir, "holders", `${handles[name]!.id}.json`), "utf8"));
  const recordOf = (name: keyof typeof pgid) => readSuspensions(dir).find((r) => r.pgid === pgid[name]);
  const tick = (name: keyof typeof pgid, over: Partial<LeaseOptions> = {}): boolean => suspendNewest(opts(over), handles[name]!, pgid[name], "sleep 100", stop);
  const owner = (name: keyof typeof pgid, by = "jake"): SuspensionRecord => ({ pgid: pgid[name], by, reason: "mine", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader: "sleep 100" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-suspend-"));
    lease = scriptedLease(dir);
    step = 4;
    freePct = 60;
    stop = vi.fn(() => true);
    // a is the oldest, c the newest; each is 5 s younger than the one before, and all are 20 s old or more once 30 s pass.
    handles = {};
    for (const name of ["a", "b", "c"] as const) {
      handles[name] = tryAcquireLease(opts(), { command: `job ${name}`, cwd: "/w", suspendable: true })!;
      advance(5 * SECOND);
    }
    advance(30 * SECOND);
    plantCpu(lease, 0.97, TICKS);
  });
  afterEach(() => {
    for (const h of Object.values(handles)) h.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("suspends the newest at CPU 0.97: record, then holder mark, then SIGSTOP of its own group", () => {
    stop.mockImplementation(() => {
      expect(recordOf("c")).toMatchObject({ by: "lease", reason: expect.stringContaining("CPU"), leader: "sleep 100" });
      expect(holderRec("c").suspended).toBe(true);
      return true;
    });
    expect(tick("c")).toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith(pgid.c);
    expect(existsSync(join(dir, "lastSuspend"))).toBe(true);
    expect(statSync(join(dir, "lastSuspend")).mtimeMs).toBeCloseTo(lease.clock.ms, -1);
  });

  it.each<[string, () => void, boolean]>([
    ["CPU 0.95", () => plantCpu(lease, 0.95, TICKS), true],
    ["CPU 0.94", () => plantCpu(lease, 0.94, TICKS), false],
    ["a null CPU reading", () => plantCpu(lease, null, TICKS), false],
    ["free memory 12%", () => { plantCpu(lease, 0.1, TICKS); freePct = 12; }, true],
    ["free memory 13%", () => { plantCpu(lease, 0.1, TICKS); freePct = 13; }, false],
    ["step 0", () => { plantCpu(lease, 0.1, TICKS); step = 0; }, true],
    ["step 1 with 3 live, more holders than the step allows, which stops admissions and never suspends", () => { plantCpu(lease, 0.1, TICKS); step = 1; }, false],
  ])("trigger: %s -> suspends %s", (_n, arrange, suspends) => {
    arrange();
    expect(tick("c")).toBe(suspends);
    expect(stop).toHaveBeenCalledTimes(suspends ? 1 : 0);
    expect(recordOf("c") !== undefined).toBe(suspends);
    expect(holderRec("c").suspended === true).toBe(suspends);
  });

  it("never signals for a holder that is not the newest suspendable running one", () => {
    expect(tick("a")).toBe(false);
    expect(tick("b")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(readSuspensions(dir)).toEqual([]);
  });

  it("never suspends the oldest running holder, even when it is the only suspendable one", () => {
    handles.c!.release();
    handles.b!.release();
    expect(tick("a")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("skips a newest holder that is not suspendable and suspends the newest one that is", () => {
    handles.d = tryAcquireLease(opts(), { command: "xcodebuild test", cwd: "/w" })!;
    advance(SUSPEND_MIN_RUN_MS + SECOND);
    plantCpu(lease, 0.97, TICKS);
    expect(tick("c")).toBe(true);
  });

  it("never suspends a holder younger than 20 s", () => {
    advance(-20 * SECOND); // c is now 15 s old
    plantCpu(lease, 0.97, TICKS);
    expect(tick("c")).toBe(false);
    advance(5 * SECOND);
    plantCpu(lease, 0.97, TICKS);
    expect(tick("c")).toBe(true);
  });

  it.each<[string, number | undefined, boolean]>([
    ["resumed 15 s ago", 15 * SECOND, false],
    ["resumed 20 s ago", 20 * SECOND, true],
    ["never resumed", undefined, true],
    ["a wrongly typed resumedAt", -1, true],
    ["a resumedAt 10 minutes in the future, read as absent", -10 * 60 * SECOND, true],
  ])("measures run time from the later of startedAt and resumedAt: %s", (_n, ago, suspends) => {
    const file = join(dir, "holders", `${handles.c!.id}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    if (ago !== undefined) rec.resumedAt = ago === -1 ? "soon" : lease.clock.ms - ago;
    writeFileSync(file, JSON.stringify(rec));
    expect(tick("c")).toBe(suspends);
  });

  it("suspends at most once per 15 s machine-wide, then the next newest running holder", () => {
    expect(tick("c")).toBe(true);
    advance(10 * SECOND);
    plantCpu(lease, 0.97, TICKS);
    expect(tick("b")).toBe(false);
    advance(5 * SECOND);
    plantCpu(lease, 0.97, TICKS);
    // c is suspended, so b is now the newest running holder, and not the oldest.
    expect(tick("b")).toBe(true);
    expect(stop.mock.calls).toEqual([[pgid.c], [pgid.b]]);
  });

  it("reads a lastSuspend mark from the future as elapsed", () => {
    const mark = join(dir, "lastSuspend");
    writeFileSync(mark, "");
    const future = (lease.clock.ms + 60 * SECOND) / 1000;
    utimesSync(mark, future, future);
    expect(tick("c")).toBe(true);
  });

  it("does nothing while the mutex is busy", () => {
    const mutex = join(dir, ".mutex");
    writeFileSync(mutex, "");
    utimesSync(mutex, lease.clock.ms / 1000, lease.clock.ms / 1000);
    expect(tick("c")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("sends SIGSTOP only after the mutex is released", () => {
    stop.mockImplementation(() => (expect(existsSync(join(dir, ".mutex"))).toBe(false), true));
    expect(tick("c")).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("emits one suspend event after the SIGSTOP, and none when the signal fails", () => {
    stop.mockImplementation(() => (expect(lease.events.filter((e) => e.type === "suspend")).toEqual([]), true));
    expect(tick("c")).toBe(true);
    expect(lease.events.filter((e) => e.type === "suspend")).toEqual([{ type: "suspend", id: handles.c!.id, pgid: pgid.c, reason: expect.stringContaining("CPU"), class: "heavy" }]);
    lease.events.length = 0;
    advance(20 * SECOND);
    plantCpu(lease, 0.97, TICKS);
    stop.mockReturnValue(false);
    expect(tick("b")).toBe(false);
    expect(lease.events.filter((e) => e.type === "suspend")).toEqual([]);
  });

  it("never selects a session holder, even a newer one", async () => {
    const session = (await acquireSessionLease(opts(), { command: "claude", cwd: "/w" })) as LeaseHandle;
    advance(SUSPEND_MIN_RUN_MS + SECOND);
    plantCpu(lease, 0.97, TICKS);
    expect(tick("c")).toBe(true);
    session.release();
  });

  describe("a record the lease did not write", () => {
    it("is left alone: no SIGSTOP, no holder mark, record kept", () => {
      writeSuspension(dir, owner("c"));
      expect(tick("c")).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(holderRec("c").suspended).toBeUndefined();
      expect(recordOf("c")).toMatchObject({ by: "jake", reason: "mine" });
    });

    it("is replaced when it is a leftover with by: lease", () => {
      writeSuspension(dir, owner("c", "lease"));
      expect(tick("c")).toBe(true);
      expect(recordOf("c")).toMatchObject({ by: "lease", reason: expect.stringContaining("CPU") });
    });

    describe("is ranked as stopped", () => {
      const own = (name: keyof typeof pgid): void => void handles[name]!.setChildPid(process.pid, pgid[name]);
      const mutexTries = (run: () => void): number => {
        const seen: string[] = [];
        const restore = failFsCall("openSync", (p) => (p.endsWith(".mutex") && seen.push(p), false), "EIO");
        try {
          run();
        } finally {
          restore();
        }
        return seen.length;
      };

      it("so the next-newest suspendable running holder is suspended in its place", () => {
        for (const name of ["a", "b", "c"] as const) own(name);
        writeSuspension(dir, owner("c"));
        expect(tick("c")).toBe(false);
        expect(tick("b")).toBe(true);
        expect(stop).toHaveBeenCalledExactlyOnceWith(pgid.b);
        expect(recordOf("c")).toMatchObject({ by: "jake" });
      });

      it("also when it is the lease's record on a group whose mark was cleared (a refused dead-owner continue)", () => {
        for (const name of ["a", "b", "c"] as const) own(name);
        writeSuspension(dir, owner("c", "lease"));
        expect(tick("b")).toBe(true);
        expect(stop).toHaveBeenCalledExactlyOnceWith(pgid.b);
      });

      it("except for the holder whose tick it is, which replaces its own leftover lease record", () => {
        for (const name of ["a", "b", "c"] as const) own(name);
        writeSuspension(dir, owner("c", "lease"));
        expect(tick("c")).toBe(true);
        expect(stop).toHaveBeenCalledExactlyOnceWith(pgid.c);
      });

      it("and the governor tick of the stopped group returns before it takes the mutex or writes", () => {
        writeSuspension(dir, owner("c"));
        let result = true;
        expect(mutexTries(() => void (result = tick("c")))).toBe(0);
        expect(result).toBe(false);
        expect(readSuspensions(dir)).toEqual([owner("c")]);
        expect(mutexTries(() => void tick("b"))).toBeGreaterThan(0);
      });
    });
  });

  describe("an interruption at each step", () => {
    const state = (): { record: boolean; mark: boolean } => ({ record: recordOf("c") !== undefined, mark: holderRec("c").suspended === true });

    it.each<[string, () => () => void]>([
      ["the record write", () => failFsCall("linkSync", (p) => p.includes("suspensions"), "EIO")],
      ["the holder mark write", () => failFsCall("renameSync", (p) => p.includes("holders"), "EIO")],
      ["the lastSuspend mark write", () => failFsCall("renameSync", (p) => p.endsWith("lastSuspend") || /lastSuspend\.\d+\./.test(p), "EIO")],
    ])("fails %s: no SIGSTOP, and neither record nor mark is left", (_n, inject) => {
      const restore = inject();
      try {
        expect(() => tick("c")).toThrow();
      } finally {
        restore();
      }
      expect(stop).not.toHaveBeenCalled();
      expect(state()).toEqual({ record: false, mark: false });
    });

    it.each<[string, () => boolean]>([
      ["reports the group gone", () => false],
      ["throws", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); }],
    ])("a SIGSTOP that %s takes the record and mark back, and a throw reaches the caller", (n, fails) => {
      stop.mockImplementation(fails);
      if (n === "throws") expect(() => tick("c")).toThrow(/EPERM/);
      else expect(tick("c")).toBe(false);
      expect(state()).toEqual({ record: false, mark: false });
    });

    it("has both the record and the mark in place whenever SIGSTOP is sent", () => {
      const seen: { record: boolean; mark: boolean }[] = [];
      stop.mockImplementation(() => (seen.push(state()), true));
      tick("c");
      expect(seen).toEqual([{ record: true, mark: true }]);
    });
  });
});

class FakeChild extends EventEmitter {
  kill = vi.fn((_sig?: NodeJS.Signals) => true);
  pid = 4321;
}

describe("runLeased governor tick", () => {
  let dir: string;
  let lease: ScriptedLease;
  let child: FakeChild;
  let tickFns: (() => void)[];
  let cancelled: number;
  let kill: ReturnType<typeof vi.fn>;
  let errs: string[];
  let freePct: number;

  const leaseOpts = (over: Partial<LeaseOptions> = {}): LeaseOptions =>
    lease.opts({
      policy: WIDE,
      cpuTimes: () => TICKS,
      headroom: scriptedHeadroomSampler(() => ({ level: "normal", step: 4, signals: { level: "normal", freePct } })),
      ...over,
    });
  const deps = (over: Partial<LeaseCliDeps> = {}): LeaseCliDeps => ({
    leaseOptions: () => leaseOpts(),
    acquire: acquireLease,
    leaseStatus: () => { throw new Error("unused"); },
    ancestors: () => [],
    spawn: () => child,
    env: {},
    cwd: "/w",
    out: () => {},
    err: (l) => void errs.push(l),
    signals: Object.assign(new EventEmitter(), { pid: 999, kill }),
    governor: { every: (fn) => (tickFns.push(fn), () => void cancelled++) },
    ...over,
  });
  const args = { kind: "run" as const, argv: ["sleep", "100"], background: true, suspendable: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-suspend-run-"));
    lease = scriptedLease(dir);
    child = new FakeChild();
    tickFns = [];
    cancelled = 0;
    kill = vi.fn();
    errs = [];
    freePct = 60;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts no timer without a governor dep, for a plain run, or without a group of its own", async () => {
    for (const [a, d] of [
      [args, { governor: undefined }],
      [{ ...args, suspendable: false }, {}],
      [{ ...args, background: false }, {}],
    ] as const) {
      const done = runLeased({ ...a }, deps(d));
      await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
      child.emit("close", 0, null);
      await done;
      child.removeAllListeners();
    }
    expect(tickFns).toEqual([]);
  });

  it("clears the timer when the run finishes", async () => {
    const done = runLeased(args, deps());
    await vi.waitFor(() => expect(tickFns).toHaveLength(1));
    child.emit("close", 0, null);
    await done;
    expect(cancelled).toBe(1);
  });

  it("SIGSTOPs only its own group on a tick, and a lone holder is never suspended", async () => {
    const done = runLeased(args, deps());
    await vi.waitFor(() => expect(tickFns).toHaveLength(1));
    lease.clock.ms += SUSPEND_MIN_RUN_MS + SECOND;
    plantCpu(lease, 0.99, TICKS);
    tickFns[0]!();
    expect(kill).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await done;
  });

  it("suspends its own group when it is the newest of two, and removes its record on exit", async () => {
    const o = lease.opts({ policy: WIDE, cpuTimes: () => TICKS, headroom: scriptedHeadroomSampler({ level: "normal", step: 4, signals: { level: "normal", freePct: 60 } }) });
    const first = tryAcquireLease(o, { command: "job a", cwd: "/w", suspendable: true })!;
    lease.clock.ms += SECOND;
    const done = runLeased(args, deps());
    await vi.waitFor(() => expect(tickFns).toHaveLength(1));
    lease.clock.ms += SUSPEND_MIN_RUN_MS + SECOND;
    plantCpu(lease, 0.99, TICKS);
    tickFns[0]!();
    expect(kill.mock.calls).toEqual([[-4321, "SIGSTOP"]]);
    expect(readSuspensions(dir)).toMatchObject([{ pgid: 4321, by: "lease", leader: "sleep 100" }]);
    child.emit("close", 0, null);
    await done;
    expect(readSuspensions(dir)).toEqual([]);
    first.release();
  });

  /** A second, older suspendable holder, so the run's own holder is the newest of two and not the oldest. */
  const olderHolder = (): LeaseHandle => {
    const h = tryAcquireLease(lease.opts({ policy: WIDE, cpuTimes: () => TICKS, headroom: scriptedHeadroomSampler({ level: "normal", step: 4, signals: { level: "normal", freePct: 60 } }) }), { command: "job a", cwd: "/w", suspendable: true })!;
    lease.clock.ms += SECOND;
    return h;
  };
  const overloadAfterMinRun = (): void => {
    lease.clock.ms += SUSPEND_MIN_RUN_MS + SECOND;
    plantCpu(lease, 0.99, TICKS);
  };
  const sigstops = (): unknown[] => kill.mock.calls.filter((c) => c[1] === "SIGSTOP");
  /** Starts a run as the newer of two suspendable holders, overloads the machine past the 20 s minimum and returns the run and the older holder. */
  const startNewest = async (over: Partial<LeaseCliDeps> = {}): Promise<{ done: Promise<number>; first: LeaseHandle }> => {
    const first = olderHolder();
    const done = runLeased(args, deps(over));
    await vi.waitFor(() => expect(tickFns).toHaveLength(1));
    overloadAfterMinRun();
    return { done, first };
  };

  it("reports a failed leader lookup, retries on the next tick and keeps running", async () => {
    let lookups = 0;
    const processCommand = (): string => {
      if (lookups++ === 0) throw new Error("ps failed");
      return "sleep 100";
    };
    const { done, first } = await startNewest({ leaseOptions: () => leaseOpts({ processCommand }) });
    expect(() => tickFns[0]!()).not.toThrow();
    expect(errs.at(-1)).toMatch(/suspend check failed: ps failed/);
    expect(sigstops()).toEqual([]);
    tickFns[0]!();
    expect(sigstops()).toEqual([[-4321, "SIGSTOP"]]);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("names the bound when the leader lookup times out", async () => {
    const processCommand = (): string => {
      throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    const { done, first } = await startNewest({ leaseOptions: () => leaseOpts({ processCommand }) });
    tickFns[0]!();
    expect(errs.at(-1)).toMatch(/suspend check failed: timed out at the 2 s bound$/);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("reports a SIGSTOP that throws EPERM and leaves no record", async () => {
    kill.mockImplementation((_pid: number, sig: string) => {
      if (sig === "SIGSTOP") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    const { done, first } = await startNewest();
    tickFns[0]!();
    expect(errs.at(-1)).toMatch(/suspend check failed: kill EPERM/);
    expect(readSuspensions(dir)).toEqual([]);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("never suspends once %s has been forwarded, and clears its timer", async (sig) => {
    const signals = Object.assign(new EventEmitter(), { pid: 999, kill });
    const { done, first } = await startNewest({ signals });
    signals.emit(sig);
    tickFns[0]!();
    expect(sigstops()).toEqual([]);
    expect(readSuspensions(dir)).toEqual([]);
    expect(cancelled).toBe(1);
    child.emit("close", null, sig);
    await done;
    first.release();
  });

  it("prints a paused-on-purpose line when it suspends its group", async () => {
    const { done, first } = await startNewest();
    tickFns[0]!();
    expect(errs.at(-1)).toMatch(/paused on purpose \(SIGSTOP\).*do not kill or re-run it/);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("leaves a record someone else wrote in place of the lease's when the run finishes", async () => {
    const { done, first } = await startNewest();
    tickFns[0]!();
    // The owner resumes the group (removing the lease's record) and suspends it again with a record of their own.
    rmSync(join(dir, "suspensions", "4321.json"));
    writeSuspension(dir, { pgid: 4321, by: "jake", reason: "mine", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader: "sleep 100" });
    child.emit("close", 0, null);
    expect(await done).toBe(0);
    expect(readSuspensions(dir)).toMatchObject([{ pgid: 4321, by: "jake" }]);
    first.release();
  });

  /** Suspends the run's group (it is the newer of two), then lets the machine recover. */
  const suspendThenRecover = async (): Promise<{ done: Promise<number>; first: LeaseHandle }> => {
    const started = await startNewest();
    tickFns[0]!();
    expect(sigstops()).toHaveLength(1);
    lease.clock.ms += SECOND;
    plantCpu(lease, 0.1, TICKS);
    return started;
  };
  const sigconts = (): unknown[] => kill.mock.calls.filter((c) => c[1] === "SIGCONT");

  it("resumes its own group on a later tick once the machine has recovered, and reports it", async () => {
    const { done, first } = await suspendThenRecover();
    tickFns[0]!();
    expect(kill.mock.calls).toEqual([[-4321, "SIGSTOP"], [-4321, "SIGCONT"]]);
    expect(readSuspensions(dir)).toEqual([]);
    expect(errs.at(-1)).toMatch(/resumed \(SIGCONT\)/);
    expect(lease.events.map((e) => e.type).filter((t) => t === "suspend" || t === "resume")).toEqual(["suspend", "resume"]);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("stays stopped while the machine is still loaded", async () => {
    const { done, first } = await suspendThenRecover();
    plantCpu(lease, 0.9, TICKS);
    tickFns[0]!();
    expect(sigconts()).toEqual([]);
    expect(readSuspensions(dir)).toHaveLength(1);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("clears its mark on the next tick after an owner's resume, whatever the load, and sends no signal", async () => {
    const { done, first } = await suspendThenRecover();
    rmSync(join(dir, "suspensions", "4321.json"));
    freePct = 3;
    plantCpu(lease, 0.99, TICKS);
    tickFns[0]!();
    expect(sigconts()).toEqual([]);
    const holders = readdirSync(join(dir, "holders")).filter((f) => f.endsWith(".json"));
    expect(holders.map((f) => JSON.parse(readFileSync(join(dir, "holders", f), "utf8")).suspended)).toEqual([undefined, undefined]);
    child.emit("close", 0, null);
    await done;
    first.release();
  });

  it("does not try to remove a record on exit after it resumed", async () => {
    const { done, first } = await suspendThenRecover();
    tickFns[0]!();
    // A lease record planted after the resume survives exit only when the resume cleared the run's own suspended flag.
    writeSuspension(dir, { pgid: 4321, by: "lease", reason: "planted", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader: "sleep 100" });
    child.emit("close", 0, null);
    await done;
    expect(readSuspensions(dir)).toMatchObject([{ pgid: 4321, by: "lease" }]);
    first.release();
  });

  it("still releases its holder and resolves when removing its record fails", async () => {
    const { done, first } = await startNewest();
    tickFns[0]!();
    const restore = failFsCall("rmSync", (p) => p.includes("suspensions"), "EACCES");
    try {
      child.emit("close", 0, null);
      expect(await done).toBe(0);
    } finally {
      restore();
    }
    expect(errs.at(-1)).toMatch(/could not remove the suspension record/);
    expect(readdirSync(join(dir, "holders")).filter((f) => f.endsWith(".json"))).toEqual([`${first.id}.json`]);
    first.release();
  });
});
