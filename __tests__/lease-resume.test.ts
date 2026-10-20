import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeOldest, tryAcquireLease, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { RAMP_MS } from "../src/headroom.js";
import { readSuspensions, writeSuspension } from "../src/suspensions.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { failFsCall, plantCpu, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const WIDE = { heavyCeiling: 4, heavyWarning: 4 };
const TICKS = { idle: 1, total: 10 };
const SECOND = 1000;
const GIB = 2 ** 30;

describe("resuming the oldest suspended holder", () => {
  let dir: string;
  let lease: ScriptedLease;
  let step: number;
  let freePct: number | undefined;
  let memsizeBytes: number | undefined;
  let cont: ReturnType<typeof vi.fn>;
  let handles: Record<string, LeaseHandle>;
  const pgid = { a: 9001, b: 9002, c: 9003 };
  type Name = keyof typeof pgid;

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions =>
    lease.opts({
      policy: WIDE,
      cpuTimes: () => TICKS,
      headroom: scriptedHeadroomSampler(() => ({
        level: step === 0 ? "critical" : "normal",
        step,
        signals: freePct === undefined && memsizeBytes === undefined ? null : { level: "normal", ...(freePct !== undefined && { freePct }), ...(memsizeBytes !== undefined && { memsizeBytes }) },
      })),
      ...over,
    });
  const advance = (ms: number): void => void (lease.clock.ms += ms);
  const holderRec = (name: Name) => JSON.parse(readFileSync(join(dir, "holders", `${handles[name]!.id}.json`), "utf8"));
  const recordOf = (name: Name) => readSuspensions(dir).find((r) => r.pgid === pgid[name]);
  const record = (name: Name, by = "lease") =>
    writeSuspension(dir, { pgid: pgid[name], by, reason: "CPU 97% busy", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader: "sleep 100" });
  /** Marks `name` the way `suspendNewest` leaves it: a lease record and the holder's mark. */
  const suspend = (name: Name): void => {
    record(name);
    handles[name]!.setSuspended!(true);
  };
  const tick = (name: Name, over: Partial<LeaseOptions> = {}) => resumeOldest(opts(over), handles[name]!, pgid[name], cont);
  /** Refreshes every holder's heartbeat at the fake clock, as a live holder's own timer would. */
  const beat = (): void => readdirSync(join(dir, "holders")).forEach((f) => utimesSync(join(dir, "holders", f), lease.clock.ms / 1000, lease.clock.ms / 1000));
  const acquireAll = (): void => {
    for (const name of ["a", "b", "c"] as const) {
      handles[name] = tryAcquireLease(opts(), { command: `job ${name}`, cwd: "/w", suspendable: true })!;
      advance(5 * SECOND);
    }
    advance(30 * SECOND);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-resume-"));
    lease = scriptedLease(dir);
    step = 4;
    freePct = 60;
    memsizeBytes = undefined;
    cont = vi.fn(() => true);
    handles = {};
    acquireAll();
    suspend("a");
    plantCpu(lease, 0.1, TICKS);
  });
  afterEach(() => {
    for (const h of Object.values(handles)) h.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes the oldest suspended holder: SIGCONT of its own group, then the mark is cleared, then the record is removed", () => {
    cont.mockImplementation(() => {
      expect(existsSync(join(dir, ".mutex"))).toBe(false);
      expect(holderRec("a").suspended).toBe(true);
      expect(recordOf("a")).toBeDefined();
      return true;
    });
    expect(tick("a")).toBe("resumed");
    expect(cont).toHaveBeenCalledExactlyOnceWith(pgid.a);
    expect(holderRec("a").suspended).toBeUndefined();
    expect(recordOf("a")).toBeUndefined();
    expect(lease.events.filter((e) => e.type === "resume")).toEqual([{ type: "resume", id: handles.a!.id, pgid: pgid.a, reason: expect.stringContaining("CPU 10% busy"), class: "heavy" }]);
  });

  it.each<[string, () => void, boolean]>([
    ["CPU 0.84", () => plantCpu(lease, 0.84, TICKS), true],
    ["CPU 0.85", () => plantCpu(lease, 0.85, TICKS), false],
    ["a null CPU reading", () => plantCpu(lease, null, TICKS), false],
    ["count mode, free memory 21%", () => { freePct = 21; }, true],
    ["count mode, free memory 20%", () => { freePct = 20; }, false],
    ["count mode, no free reading", () => { freePct = undefined; }, false],
    ["step 1 with two running holders (room for one)", () => { step = 1; }, false],
    ["step 2 with two running holders (room for two, itself is the third)", () => { step = 2; }, false],
    ["step 3 with two running holders", () => { step = 3; }, true],
  ])("trigger: %s -> resumes %s", (_n, arrange, resumes) => {
    arrange();
    expect(tick("a")).toBe(resumes ? "resumed" : undefined);
    expect(cont).toHaveBeenCalledTimes(resumes ? 1 : 0);
    expect(holderRec("a").suspended === true).toBe(!resumes);
    expect(recordOf("a") !== undefined).toBe(!resumes);
  });

  it("at step 0 resumes only when nothing else is running", () => {
    step = 0;
    expect(tick("a")).toBeUndefined();
    handles.c!.release();
    expect(tick("a")).toBeUndefined();
    handles.b!.release();
    expect(tick("a")).toBe("resumed");
  });

  it("a lone suspended holder at step 4 still needs CPU and free memory to have recovered", () => {
    handles.c!.release();
    handles.b!.release();
    plantCpu(lease, 0.9, TICKS);
    expect(tick("a")).toBeUndefined();
  });

  it("resumes only the oldest suspended holder, so the next one waits", () => {
    suspend("b");
    expect(tick("b")).toBeUndefined();
    expect(cont).not.toHaveBeenCalled();
    expect(tick("a")).toBe("resumed");
    plantCpu(lease, 0.1, TICKS);
    expect(tick("b")).toBe("resumed");
    expect(cont.mock.calls).toEqual([[pgid.a], [pgid.b]]);
  });

  it("does nothing while the mutex is busy", () => {
    const mutex = join(dir, ".mutex");
    writeFileSync(mutex, "");
    utimesSync(mutex, lease.clock.ms / 1000, lease.clock.ms / 1000);
    expect(tick("a")).toBeUndefined();
    expect(cont).not.toHaveBeenCalled();
  });

  describe("weight mode", () => {
    beforeEach(() => {
      for (const h of Object.values(handles)) h.release();
      handles = {};
      rmSync(join(dir, "suspensions"), { recursive: true, force: true });
      memsizeBytes = 16 * GIB; // usable 12 GiB at the default 25% reserve
      freePct = undefined; // the step's share of usable: 12 GiB at step 4
    });
    /** Admission would refuse weights that do not fit together, so they are written into the holder files after the holders are in. */
    const setUp = (weights: Partial<Record<Name, number>>, suspended: Name[] = ["a"]): void => {
      acquireAll();
      suspended.forEach(suspend);
      for (const [name, weight] of Object.entries(weights)) {
        const file = join(dir, "holders", `${handles[name]!.id}.json`);
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), weight }));
      }
      plantCpu(lease, 0.1, TICKS);
    };

    it.each<[string, Partial<Record<Name, number>>, boolean]>([
      ["fits beside the running holders", { a: 4 * GIB, b: 4 * GIB, c: 4 * GIB }, true],
      ["does not fit beside the running holders, though two of four slots run", { a: 5 * GIB, b: 4 * GIB, c: 4 * GIB }, false],
    ])("a suspended holder that %s -> resumes %s", (_n, weights, resumes) => {
      setUp(weights);
      expect(tick("a")).toBe(resumes ? "resumed" : undefined);
      expect(cont).toHaveBeenCalledTimes(resumes ? 1 : 0);
    });

    it("at 22% free with a 25% reserve stays suspended, and at 60% free, settled, resumes", () => {
      setUp({});
      freePct = 22;
      expect(tick("a")).toBeUndefined();
      freePct = 60;
      advance(RAMP_MS);
      beat();
      plantCpu(lease, 0.1, TICKS);
      expect(tick("a")).toBe("resumed");
    });

    it("does not count another suspended holder's weight as room: two suspended and free memory inside the reserve stay stopped", () => {
      setUp({ a: 4 * GIB, b: 4 * GIB, c: 4 * GIB }, ["a", "b"]);
      freePct = 12.5; // 2 GiB free, inside the 4 GiB reserve
      advance(RAMP_MS);
      beat();
      plantCpu(lease, 0.1, TICKS);
      expect(tick("a")).toBeUndefined();
      freePct = 40; // 6.4 GiB free: 2.4 GiB of room beyond the reserve, and the running holder plus the oldest settle
      expect(tick("a")).toBe("resumed");
    });

    it("a holder heavier than the budget resumes alone, and not beside a running one", () => {
      setUp({ a: 20 * GIB, b: 1 * GIB, c: 1 * GIB });
      expect(tick("a")).toBeUndefined();
      handles.c!.release();
      handles.b!.release();
      expect(tick("a")).toBe("resumed");
    });

    // Alone, step 0 and room are waived but the memory test is not: free memory above the 4 GiB reserve (16 GiB × 25%), or the step's share without a free reading.
    it.each<[string, boolean, number | undefined]>([
      ["5% free (0.8 GiB, inside the reserve)", false, 5],
      ["30% free (4.8 GiB, above the reserve)", true, 30],
      ["no free reading (the step's share is 0)", false, undefined],
    ])("alone at step 0 with %s -> resumes %s", (_n, resumes, free) => {
      setUp({});
      handles.c!.release();
      handles.b!.release();
      step = 0;
      freePct = free;
      expect(tick("a")).toBe(resumes ? "resumed" : undefined);
    });
  });

  it("re-checks the record before the SIGCONT: an owner who took the group over during the decision keeps it stopped", () => {
    const takeOver = (): typeof TICKS => {
      rmSync(join(dir, "suspensions", `${pgid.a}.json`));
      record("a", "jake");
      return TICKS;
    };
    expect(tick("a", { cpuTimes: takeOver })).toBe("cleared");
    expect(cont).not.toHaveBeenCalled();
    expect(recordOf("a")?.by).toBe("jake");
    expect(holderRec("a").suspended).toBeUndefined();
  });

  describe("a record the lease no longer holds", () => {
    const owner = (): void => {
      rmSync(join(dir, "suspensions", `${pgid.a}.json`));
    };

    it.each<[string, () => void]>([
      ["the owner's resume removed it", owner],
      ["the owner replaced it with their own", () => { owner(); record("a", "jake"); }],
    ])("%s: the next tick clears the mark under any load, with no signal", (_n, arrange) => {
      arrange();
      step = 0;
      plantCpu(lease, 0.99, TICKS);
      freePct = 5;
      expect(tick("a")).toBe("cleared");
      expect(cont).not.toHaveBeenCalled();
      expect(holderRec("a").suspended).toBeUndefined();
      expect(recordOf("a")?.by).toBe(_n.includes("replaced") ? "jake" : undefined);
    });

    it("lets a gated ticket in once the mark is gone", () => {
      owner();
      const gated = (): LeaseHandle | null => tryAcquireLease(opts(), { command: "gated", cwd: "/w", gated: true });
      plantCpu(lease, 0.1, TICKS);
      expect(gated()).toBeNull();
      tick("a");
      plantCpu(lease, 0.1, TICKS);
      handles.d = gated()!;
      expect(handles.d).not.toBeNull();
    });
  });

  describe("an interruption at each step", () => {
    it("a SIGCONT that throws leaves the mark and the record, and reaches the caller", () => {
      cont.mockImplementation(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
      expect(() => tick("a")).toThrow(/EPERM/);
      expect(holderRec("a").suspended).toBe(true);
      expect(recordOf("a")).toBeDefined();
    });

    it("a mark that cannot be cleared leaves the record", () => {
      const restore = failFsCall("renameSync", (p) => p.includes("holders"), "EIO");
      try {
        expect(() => tick("a")).toThrow();
      } finally {
        restore();
      }
      expect(cont).toHaveBeenCalledOnce();
      expect(holderRec("a").suspended).toBe(true);
      expect(recordOf("a")).toBeDefined();
    });

    it("a group that is gone still has its mark and record cleared", () => {
      cont.mockReturnValue(false);
      expect(tick("a")).toBe("resumed");
      expect(holderRec("a").suspended).toBeUndefined();
      expect(recordOf("a")).toBeUndefined();
    });
  });
});
