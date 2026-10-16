import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as barrel from "../src/index.js";
import { acquireLease, acquireSessionLease, leaseStatus, type HolderMeta, type LeaseHandle, type LeaseOptions, type LeaseRefusal, type LeaseStatus } from "../src/lease.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import type { PressureLevel, PressurePolicy } from "../src/memory-pressure.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { scriptedLease, type FakeLeaseClock, type ScriptedLease } from "./helpers/lease.js";

const meta: HolderMeta = { command: "session 1", cwd: "/work" };
const HEARTBEAT_STALE_MS = 90_000;
const TICKET_FRESH_MS = 15_000;
const isHandle = (r: LeaseHandle | LeaseRefusal): r is LeaseHandle => "leased" in r;
const reading = (step: number, level: PressureLevel = step === 0 ? "critical" : "normal"): HeadroomReading => ({ level, step, signals: null });

interface ClassUnderTest {
  name: string;
  holders: string;
  waiting: string;
  acquire: typeof acquireLease;
  policy(ceiling: number): PressurePolicy;
}

const classes: ClassUnderTest[] = [
  { name: "heavy", holders: "holders", waiting: "waiting", acquire: acquireLease, policy: (c) => ({ heavyCeiling: c, heavyWarning: 1 }) },
  { name: "sessions", holders: "sessions", waiting: "sessions-waiting", acquire: acquireSessionLease, policy: (c) => ({ heavyCeiling: 1, heavyWarning: 1, sessionCeiling: c }) },
];

describe("session holder class", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;
  let fake: FakeLeaseClock;
  let alive: Set<number>;
  const sessionPolicy = (m: number): PressurePolicy => classes[1]!.policy(m);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-sessions-"));
    dir = join(tmp, "lease");
    lease = scriptedLease(dir);
    ({ clock: fake, alive } = lease);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(tmp, { recursive: true, force: true });
  });

  const opts = (step: number, over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts({ headroom: scriptedHeadroomSampler(reading(step)), ...over });
  const mkdir = (name: string): string => (mkdirSync(join(dir, name), { recursive: true, mode: 0o700 }), join(dir, name));
  const names = (name: string): string[] => (existsSync(join(dir, name)) ? readdirSync(join(dir, name)).sort() : []);
  /** A holder file in `name/`, its heartbeat `beatAgoMs` before the injected clock. */
  const plantHolder = (name: string, id: string, rec: Record<string, unknown> = {}, beatAgoMs = 0): void => {
    const file = join(mkdir(name), `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, pid: process.pid, command: "x", cwd: "/", startedAt: fake.ms, level: "normal", ...rec }));
    const at = (fake.ms - beatAgoMs + 0.5) / 1000;
    utimesSync(file, at, at);
  };
  /** A ticket for a waiter in another process: its pid is alive unless `dead`, and its last refresh was `ageMs` before the clock. */
  const plantTicket = (name: string, id: string, seq: number, { ageMs = 0, dead = false, ...extra }: { ageMs?: number; dead?: boolean } & Record<string, unknown> = {}): void => {
    const file = join(mkdir(name), `${id}.json`);
    writeFileSync(file, JSON.stringify({ seq, id, pid: 5000 + seq, label: "other", gated: false, ...extra }));
    const at = (fake.ms - ageMs) / 1000;
    utimesSync(file, at, at);
    if (!dead) alive.add(5000 + seq);
  };
  /** Admits as many acquires as the class allows right now, none waiting; returns the handles. */
  const fill = async (acquire: ClassUnderTest["acquire"], o: LeaseOptions, tries = 12): Promise<LeaseHandle[]> => {
    const got: LeaseHandle[] = [];
    for (let i = 0; i < tries; i++) {
      const r = await acquire(o, meta, { maxWaitMs: 0 });
      if (isHandle(r)) got.push(r);
    }
    return got;
  };

  describe("capacity row", () => {
    it.each([
      [6, 4, 6], [6, 3, 4], [6, 2, 2], [6, 1, 1], [6, 0, 0],
      [3, 4, 3], [3, 3, 3], [3, 2, 2], [3, 1, 1], [3, 0, 0],
      [1, 4, 1], [1, 3, 1], [1, 2, 1], [1, 1, 1], [1, 0, 0],
    ])("with M=%i at step %i holds %i, and admits exactly that many", async (m, step, capacity) => {
      const o = opts(step, { policy: sessionPolicy(m) });
      expect(leaseStatus(o).sessions.capacity).toBe(capacity);
      expect(await fill(acquireSessionLease, o)).toHaveLength(capacity);
    });

    it("defaults the ceiling to 6 for a policy that names none, and leaves heavy slots at 4/3/2/1/0", () => {
      const o = opts(4, { policy: { heavyCeiling: 4, heavyWarning: 1 } });
      expect(leaseStatus(o)).toMatchObject({ capacity: 4, sessions: { capacity: 6 } });
    });

    it.each<[PressureLevel, number]>([
      ["normal", 6],
      ["warning", 1],
      ["critical", 0],
    ])("derives the session capacity from a lone %s level as %i, with no headroom sampler", (level, capacity) => {
      const o = lease.opts({ level: Object.assign(() => level, { fresh: () => level }), policy: sessionPolicy(6) });
      expect(leaseStatus(o).sessions.capacity).toBe(capacity);
    });

    it("takes the capacity of an attempt from one sampler read", async () => {
      const read = vi.fn(() => reading(3));
      const r = await acquireSessionLease(opts(3, { headroom: scriptedHeadroomSampler(read), policy: sessionPolicy(6) }), meta, { maxWaitMs: 0 });
      (r as LeaseHandle).release();
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("reads step 0 as step 1 under the per-process override, with no session code of its own", async () => {
      const o = opts(1, { headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }), policy: sessionPolicy(6) });
      expect(leaseStatus(o).sessions.capacity).toBe(1);
      const [first, ...rest] = await fill(acquireSessionLease, o);
      expect(first!.admission.override).toBe(true);
      expect(rest).toEqual([]);
    });
  });

  describe("holders and status", () => {
    it("creates sessions/ and sessions-waiting/ at 0700 on a session acquire only", async () => {
      leaseStatus(opts(4));
      (await acquireLease(opts(4), meta) as LeaseHandle).release();
      expect(readdirSync(dir).filter((n) => n.startsWith("sessions"))).toEqual([]);
      (await acquireSessionLease(opts(4), meta) as LeaseHandle).release();
      for (const name of ["sessions", "sessions-waiting"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o700);
    });

    it("keeps the classes apart: each counts its own holders and neither blocks the other", async () => {
      const o = opts(1, { policy: sessionPolicy(6) });
      const heavy = (await acquireLease(o, meta)) as LeaseHandle;
      const session = (await acquireSessionLease(o, meta)) as LeaseHandle;
      const status = leaseStatus(o);
      expect(status.live.map((h) => h.id)).toEqual([heavy.id]);
      expect(status.sessions.live.map((h) => h.id)).toEqual([session.id]);
      expect(status).toMatchObject({ level: "normal", capacity: 1, step: 1, sessions: { capacity: 1 } });
      expect(names("holders")).toEqual([`${heavy.id}.json`]);
      expect(names("sessions")).toEqual([`${session.id}.json`]);
      heavy.release();
      session.release();
    });

    it("shows a session acquire's stopWhen and onWait the session pool as capacity and live, on the first and the confirming read", async () => {
      const o = opts(2, { headroom: scriptedHeadroomSampler(reading(2), { fresh: () => reading(3) }), policy: { ...sessionPolicy(1), heavyCeiling: 4 } });
      const heavy = (await acquireLease(o, meta)) as LeaseHandle;
      const session = (await acquireSessionLease(o, meta)) as LeaseHandle;
      const stopWhen = vi.fn((_s: LeaseStatus) => true);
      expect(await acquireSessionLease(o, meta, { stopWhen })).toMatchObject({ refused: "stopped", live: 1 });
      const [first, confirmed] = stopWhen.mock.calls.map(([s]) => s as LeaseStatus);
      expect(first).toMatchObject({ step: 2, capacity: 1, sessions: { capacity: 1 } });
      expect(confirmed).toMatchObject({ step: 3, capacity: 1, sessions: { capacity: 1 } });
      for (const s of [first!, confirmed!]) {
        expect(s.live.map((h) => h.id)).toEqual([session.id]);
        expect(s.sessions.live.map((h) => h.id)).toEqual([session.id]);
      }
      const onWait = vi.fn();
      await acquireSessionLease(o, meta, { maxWaitMs: 1, onWait });
      expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ capacity: 1, live: [expect.objectContaining({ id: session.id })] }));
      expect(leaseStatus(o)).toMatchObject({ capacity: 2, live: [expect.objectContaining({ id: heavy.id })], sessions: { capacity: 1 } });
      heavy.release();
      session.release();
    });

    it("never admits more session holders together than the row allows, across two option sets", async () => {
      const a = opts(3, { policy: sessionPolicy(6) });
      const b = opts(3, { policy: sessionPolicy(6) });
      const held = [...(await fill(acquireSessionLease, a, 3)), ...(await fill(acquireSessionLease, b, 3)), ...(await fill(acquireSessionLease, a, 3))];
      expect(held).toHaveLength(4);
      expect(names("sessions")).toHaveLength(4);
      held.forEach((h) => h.release());
      expect(names("sessions")).toEqual([]);
    });

    it("returns the admission when removing the admitted ticket fails, and leaves no holder behind", async () => {
      const o = opts(1, { policy: sessionPolicy(6) });
      const holder = (await acquireSessionLease(o, meta)) as LeaseHandle;
      fake.onSleep = () => holder.release();
      const real = fs.rmSync;
      vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
        if (String(path).includes("/sessions-waiting/")) throw Object.assign(new Error("boom"), { code: "EIO" });
        return real(path, options);
      });
      syncBuiltinESMExports();
      const r = await acquireSessionLease(o, meta);
      expect(r).toMatchObject({ leased: true });
      (r as LeaseHandle).release();
      expect(names("sessions")).toEqual([]);
    });

    it("records no suspendable mark on a session holder", async () => {
      const h = (await acquireSessionLease(opts(4), { ...meta, suspendable: true })) as LeaseHandle;
      expect(JSON.parse(readFileSync(join(dir, "sessions", `${h.id}.json`), "utf8"))).not.toHaveProperty("suspendable");
      h.release();
    });

    it("exports acquireSessionLease from the barrel", () => {
      expect(barrel.acquireSessionLease).toBe(acquireSessionLease);
    });
  });

  describe("liveness", () => {
    it("frees a slot 90 s after the heartbeat lapses even while a recorded child PID is alive", async () => {
      alive.add(4321);
      plantHolder("sessions", "e-1", { childPid: 4321 }, HEARTBEAT_STALE_MS - 1_000);
      const o = opts(1, { policy: sessionPolicy(6) });
      expect(await acquireSessionLease(o, meta, { maxWaitMs: 0 })).toMatchObject({ refused: "max-wait", live: 1 });
      fake.ms += 2_000;
      const r = await acquireSessionLease(o, meta, { maxWaitMs: 0 });
      expect(isHandle(r)).toBe(true);
      expect(lease.events).toContainEqual({ type: "reap", id: "e-1", reason: "stale-heartbeat" });
      expect(names("sessions")).toEqual([`${(r as LeaseHandle).id}.json`]);
    });

    it("writes a holder reaped after a stall back on its next beat, so the resumed engine counts again and new admissions wait", async () => {
      vi.useFakeTimers();
      const o = opts(4, { policy: sessionPolicy(1) });
      const a = (await acquireSessionLease(o, meta, { maxWaitMs: 0 })) as LeaseHandle;
      fake.ms += HEARTBEAT_STALE_MS + 1_000; // its event loop missed every beat
      const b = (await acquireSessionLease(o, meta, { maxWaitMs: 0 })) as LeaseHandle;
      expect(lease.events).toContainEqual({ type: "reap", id: a.id, reason: "stale-heartbeat" });
      vi.advanceTimersByTime(30_000);
      fake.ms += 30_000;
      expect(leaseStatus(o).sessions.live.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
      expect(await acquireSessionLease(o, meta, { maxWaitMs: 0 })).toMatchObject({ refused: "max-wait", live: 2 });
      a.release();
      b.release();
      vi.advanceTimersByTime(30_000);
      expect(names("sessions")).toEqual([]);
    });
  });

  describe.each(classes)("$name tickets", (cls) => {
    const o = (step: number, ceiling: number, over: Partial<LeaseOptions> = {}): LeaseOptions => opts(step, { policy: cls.policy(ceiling), ...over });
    const ticket = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, cls.waiting, `${id}.json`), "utf8"));
    const tryOnce = async (options: LeaseOptions): Promise<boolean> => {
      const r = await cls.acquire(options, meta, { maxWaitMs: 0 });
      if (isHandle(r)) r.release();
      return isHandle(r);
    };

    it.each<[string, number, { id: string; seq: number; ageMs?: number; dead?: boolean }[], boolean, string[]]>([
      ["the one eligible ticket ahead, with two free slots", 0, [{ id: "a", seq: 1 }], true, ["a.json"]],
      ["an eligible ticket ahead, with one free slot", 1, [{ id: "a", seq: 1 }], false, ["a.json"]],
      ["a stale ticket (its waiter stopped), passed over and kept", 1, [{ id: "a", seq: 1, ageMs: TICKET_FRESH_MS + 1_000 }], true, ["a.json"]],
      ["a dead waiter's ticket, reaped", 1, [{ id: "a", seq: 1, dead: true }], true, []],
    ])("with %s", async (_name, holders, planted, admitted, left) => {
      for (let i = 0; i < holders; i++) plantHolder(cls.holders, `live${i}`);
      for (const t of planted) plantTicket(cls.waiting, t.id, t.seq, t);
      expect(await tryOnce(o(2, 2))).toBe(admitted);
      expect(names(cls.waiting)).toEqual(left);
    });

    it("admits three waiters in the order they arrived, even when the last to arrive polls first", async () => {
      const holder = (await cls.acquire(o(1, 1), meta)) as LeaseHandle;
      fake.onSleep = () => holder.release();
      const slowSleep = (yields: number): LeaseOptions["sleep"] => async (ms) => {
        for (let i = 0; i < yields; i++) await new Promise((r) => setImmediate(r));
        await fake.sleep(ms);
      };
      const order: string[] = [];
      const waiter = (name: string, yields: number): Promise<void> =>
        cls.acquire(o(1, 1, { sleep: slowSleep(yields) }), meta).then((r) => {
          order.push(name);
          (r as LeaseHandle).release();
        });
      await Promise.all([waiter("A", 2), waiter("B", 1), waiter("C", 0)]);
      expect(order).toEqual(["A", "B", "C"]);
      expect(names(cls.waiting)).toEqual([]);
    });

    it("confirms a stop on a fresh step read over the first scan's holders, so a holder written during the read does not undo it", async () => {
      const fresh = (): HeadroomReading => (plantHolder(cls.holders, "late"), reading(0));
      const stopWhen = vi.fn((s: LeaseStatus) => s.level === "critical" && s.live.length === 0);
      const options = o(0, 4, { headroom: scriptedHeadroomSampler(reading(0), { fresh }) });
      expect(await cls.acquire(options, meta, { stopWhen, maxWaitMs: 0 })).toMatchObject({ refused: "stopped", live: 0 });
      expect(stopWhen).toHaveBeenCalledTimes(2);
    });

    it("records the inputs of its capacity on a refused waiter's ticket", async () => {
      plantHolder(cls.holders, "live0");
      let seen: Record<string, unknown> | undefined;
      await cls.acquire(o(1, 3), meta, { maxWaitMs: 1, onWait: () => void (seen ??= ticket(names(cls.waiting)[0]!.slice(0, -".json".length))) });
      expect(seen).toMatchObject({ seq: 1, capacity: 1, step: 1, ceiling: 3 });
      expect(seen).not.toHaveProperty("override");
      const overridden = o(1, 3, { headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }) });
      await cls.acquire(overridden, meta, { maxWaitMs: 1, onWait: () => void (seen = ticket(names(cls.waiting)[0]!.slice(0, -".json".length))) });
      expect(seen).toMatchObject({ capacity: 1, step: 1, ceiling: 3, override: true });
    });

    describe("re-evaluates a ticket's capacity at the current step", () => {
      it.each<[string, Record<string, unknown>, number, number, number, boolean]>([
        ["a rise since the owner's poll does not let a younger waiter take the new slot first", { capacity: 1, step: 1, ceiling: 4 }, 2, 4, 1, false],
        ["a ticket from a build without the inputs keeps its recorded capacity", { capacity: 1 }, 2, 4, 1, true],
        ["a ticket that records no capacity at all counts", {}, 2, 4, 1, false],
        // Three live at ceiling 4 leave one free slot, so the row fails if the ticket is judged with the reader's ceiling.
        ["a lower ceiling does not hold up a waiter with a higher one", { capacity: 1, step: 4, ceiling: 1 }, 4, 4, 3, true],
        ["a ceiling above the row reaches the ahead and free counts", { capacity: 3, step: 3, ceiling: 6 }, 3, 6, 1, true],
      ])("%s", async (_name, planted, step, ceiling, holders, admitted) => {
        for (let i = 0; i < holders; i++) plantHolder(cls.holders, `live${i}`);
        plantTicket(cls.waiting, "a", 1, planted);
        expect(await tryOnce(o(step, ceiling))).toBe(admitted);
      });

      it("reads a non-number capacity or a non-boolean ready as absent, so the ticket counts", async () => {
        plantHolder(cls.holders, "live0");
        plantTicket(cls.waiting, "a", 1, { capacity: "0", ready: "no", gated: true });
        expect(await tryOnce(o(2, 4))).toBe(false);
      });

      it.each<[string, Record<string, unknown>, boolean]>([
        ["an owner without the override, at capacity 0, does not hold up an overridden waiter", { capacity: 0, step: 0, ceiling: 4 }, true],
        ["an overridden owner holds up an overridden waiter when one slot is free", { capacity: 1, step: 1, ceiling: 4, override: true }, false],
      ])("%s", async (_name, planted, admitted) => {
        plantTicket(cls.waiting, "a", 1, planted);
        const overridden = o(1, 4, { headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }) });
        expect(await tryOnce(overridden)).toBe(admitted);
      });
    });
  });
});
