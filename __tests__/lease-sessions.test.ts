import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLease,
  acquireSessionLease,
  defaultLeaseOptions,
  leaseStatus,
  tryAcquireLease,
  type HolderMeta,
  type LeaseHandle,
  type LeaseOptions,
  type LeaseRefusal,
} from "../src/lease.js";
import * as barrel from "../src/index.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import { scriptedHeadroomSampler, scriptedPressureSampler } from "../src/testing.js";
import { failFsCall, plantHolder, plantTicket, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const meta: HolderMeta = { command: "claude -p", cwd: "/work" };
const HEARTBEAT_STALE_MS = 90_000;
const TICKET_FRESH_MS = 15_000;
const reading = (step: number, level: HeadroomReading["level"] = "normal"): HeadroomReading => ({ level, step, signals: null });
const isHandle = (r: LeaseHandle | LeaseRefusal): r is LeaseHandle => "leased" in r;

describe("session holder class", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts(over);
  const at = (step: number, over: Partial<LeaseOptions> = {}): LeaseOptions => opts({ headroom: scriptedHeadroomSampler(reading(step)), ...over });
  /** One non-blocking session acquire. */
  const take = async (o: LeaseOptions): Promise<LeaseHandle | undefined> => {
    const r = await acquireSessionLease(o, meta, { maxWaitMs: 0 });
    return isHandle(r) ? r : undefined;
  };
  const names = (sub: string): string[] => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []);
  /** A session holder written by another process, its heartbeat `beatAgoMs` before the injected clock. */
  const sessionHolder = (id: string, extra: Record<string, unknown> = {}, beatAgoMs = 0): void => plantHolder(lease, id, extra, { sub: "sessions", beatAgoMs });
  /** A ticket for a waiter in another process, alive unless `dead`. */
  const sessionTicket = (sub: string, id: string, seq: number, { ageMs, dead, ...extra }: Record<string, unknown> = {}): void =>
    plantTicket(lease, id, seq, extra, { sub, ageMs: ageMs as number | undefined, dead: dead as boolean | undefined });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-sessions-"));
    dir = join(tmp, "lease");
    lease = scriptedLease(dir, { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid, 4242] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("capacity row", () => {
    it.each<[number | undefined, number[]]>([
      [undefined, [0, 1, 2, 4, 6]],
      [3, [0, 1, 2, 3, 3]],
      [1, [0, 1, 1, 1, 1]],
      [10, [0, 1, 2, 4, 10]],
    ])("with CO_LEASE_SESSION_SLOTS %s gives %j at steps 0 to 4", async (sessionSlots, row) => {
      for (const [step, capacity] of row.entries()) {
        const o = at(step, { sessionSlots });
        expect(leaseStatus(o).sessions).toEqual({ capacity, live: [] });
        const held: LeaseHandle[] = [];
        for (let i = 0; i < capacity; i++) held.push((await take(o))!);
        expect(held.every(Boolean)).toBe(true);
        expect(await take(o)).toBeUndefined();
        held.forEach((h) => h.release());
      }
    });

    it("leaves the heavy row alone", () => {
      expect(leaseStatus(at(3, { sessionSlots: 6 }))).toMatchObject({ capacity: 3, sessions: { capacity: 4 } });
    });

    it.each<[string, "normal" | "warning" | "critical", number | undefined, number]>([
      ["normal", "normal", undefined, 6],
      ["warning under the default heavyWarning of 1", "warning", undefined, 1],
      ["warning when heavyWarning is 3", "warning", 3, 4],
      ["critical", "critical", undefined, 0],
    ])("derives a session capacity from a lone %s level", (_name, level, heavyWarning, capacity) => {
      const o = opts({ level: scriptedPressureSampler(level), policy: { heavyCeiling: 4, heavyWarning: heavyWarning ?? 1 } });
      expect(leaseStatus(o).sessions!.capacity).toBe(capacity);
    });

    it("reads step 0 as step 1 under the per-process override, with no session-specific code", async () => {
      const o = opts({ headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }) });
      expect(leaseStatus(o).sessions!.capacity).toBe(1);
      const h = await take(o);
      expect(h?.admission).toMatchObject({ capacity: 1, override: true });
      h!.release();
    });

    it("reads the sampler once per attempt", async () => {
      const read = vi.fn(() => reading(4));
      const o = opts({ headroom: scriptedHeadroomSampler(read) });
      (await take(o))!.release();
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe("CO_LEASE_SESSION_SLOTS", () => {
    const parsed = (raw: string | undefined) => {
      const warnings: string[] = [];
      const env = { CO_LEASE_DIR: dir, ...(raw !== undefined && { CO_LEASE_SESSION_SLOTS: raw }) };
      const o = defaultLeaseOptions(env, { level: scriptedPressureSampler("normal"), warn: (m) => void warnings.push(m) });
      return { slots: o.sessionSlots, warnings };
    };

    it.each([
      [undefined, 6],
      ["3", 3],
      [" 12 ", 12],
    ])("reads %j as %i without a warning", (raw, slots) => {
      expect(parsed(raw)).toEqual({ slots, warnings: [] });
    });

    it.each(["0", "-1", "2.5", "many", "", "07x"])("keeps 6 and warns once for the invalid %j", (raw) => {
      const { slots, warnings } = parsed(raw);
      expect(slots).toBe(6);
      expect(warnings).toEqual([`memory-pressure: ignoring invalid CO_LEASE_SESSION_SLOTS=${JSON.stringify(raw)}; keeping 6`]);
    });
  });

  describe("sharing one directory", () => {
    it("never admits more holders across two option sets than the row allows", async () => {
      const [a, b] = [at(2), at(2)];
      const held: LeaseHandle[] = [];
      for (const o of [a, b, a, b, a]) {
        const h = await take(o);
        if (h) held.push(h);
      }
      expect(held).toHaveLength(2);
      expect(leaseStatus(a).sessions!.live).toHaveLength(2);
      held.forEach((h) => h.release());
    });

    it("keeps session and heavy slots apart", async () => {
      const o = at(4, { sessionSlots: 1 });
      const heavy = tryAcquireLease(o, meta)!;
      const session = await take(o);
      expect(session).toBeDefined();
      expect(leaseStatus(o)).toMatchObject({ live: [{ id: heavy.id }], sessions: { live: [{ id: session!.id }] } });
      heavy.release();
      session!.release();
    });
  });

  describe("directories", () => {
    it("creates sessions/ and sessions-waiting/ at 0700 on a session acquire, and no heavy directory", async () => {
      (await take(at(4)))!.release();
      for (const sub of ["sessions", "sessions-waiting"]) expect(statSync(join(dir, sub)).mode & 0o777).toBe(0o700);
      expect(names("holders")).toEqual([]);
      expect(existsSync(join(dir, "holders"))).toBe(false);
      expect(existsSync(join(dir, "waiting"))).toBe(false);
    });

    it("creates no session directory for a heavy acquire, or for leaseStatus", () => {
      tryAcquireLease(at(4), meta)!.release();
      leaseStatus(at(4));
      expect(existsSync(join(dir, "sessions"))).toBe(false);
      expect(existsSync(join(dir, "sessions-waiting"))).toBe(false);
    });

    it("reports no sessions, and creates nothing, for a missing lease directory", () => {
      expect(leaseStatus(at(4)).sessions).toEqual({ capacity: 6, live: [] });
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe("liveness", () => {
    it("frees a slot once the heartbeat lapses, even while a recorded child PID is alive", async () => {
      lease.alive.add(7777);
      sessionHolder("4242-stale", { childPid: 7777 }, HEARTBEAT_STALE_MS + 1_000);
      const h = await take(at(1));
      expect(h).toBeDefined();
      expect(lease.events).toContainEqual({ type: "reap", id: "4242-stale", reason: "stale-heartbeat", class: "sessions" });
      expect(names("sessions")).toEqual([`${h!.id}.json`]);
      h!.release();
    });

    it("ignores expiresAt: a live session PID with a lapsed heartbeat is reaped, a fresh heartbeat past expiresAt is live", async () => {
      sessionHolder("4242-lapsed", { expiresAt: lease.clock.ms + 60_000 }, HEARTBEAT_STALE_MS + 1_000);
      const h = await take(at(1));
      expect(h).toBeDefined();
      h!.release();
      sessionHolder("4242-expired", { expiresAt: lease.clock.ms - 1_000 }, 1_000);
      expect(await take(at(1))).toBeUndefined();
      expect(leaseStatus(at(1)).sessions!.live.map((x) => x.id)).toEqual(["4242-expired"]);
    });

    it("reaps a file that is not a holder record", async () => {
      mkdirSync(join(dir, "sessions"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "sessions", "junk.json"), JSON.stringify({ nonsense: true }));
      const h = await take(at(1));
      expect(h).toBeDefined();
      expect(lease.events).toContainEqual({ type: "reap", id: "junk", reason: "corrupt", class: "sessions" });
      h!.release();
    });

    it("records the holder file, and removes it on release", async () => {
      const h = (await take(at(1)))!;
      const file = join(dir, "sessions", `${h.id}.json`);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: h.id, pid: process.pid, command: "claude -p" });
      h.release();
      expect(existsSync(file)).toBe(false);
    });
  });

  // Faults are injected with `failFsCall` (a spy on `fs` plus `syncBuiltinESMExports`) rather than `vi.mock("node:fs")`: no hoisting, and each row picks its own target.
  describe("a full disk", () => {
    let restore = () => {};
    afterEach(() => restore());
    const GIB = 1024 ** 3;
    // `count` reads no memory signals; `weight` reads 16 GiB of memory, so the heavy budget at step 4 is 12 GiB (a ceiling of 1 and the default 25 % reserve).
    const modes = {
      count: reading(4),
      weight: { level: "normal", step: 4, signals: { level: "normal", memsizeBytes: 16 * GIB } } satisfies HeadroomReading,
    } as const;
    const classes = [
      { cls: "heavy", sub: "holders", waiting: "waiting", acquire: acquireLease, modes: ["count", "weight"] },
      { cls: "sessions", sub: "sessions", waiting: "sessions-waiting", acquire: acquireSessionLease, modes: ["count"] },
    ] as const;
    const targets = [
      { write: "mutex", hit: (_c: (typeof classes)[number], p: string) => p.endsWith(".mutex") },
      { write: "holder", hit: (c: (typeof classes)[number], p: string) => p.includes(`/${c.sub}/`) },
      { write: "ticket", hit: (c: (typeof classes)[number], p: string) => p.includes(`/${c.waiting}/`) },
    ];
    it.each(classes.flatMap((c) => c.modes.flatMap((mode) => targets.map((t) => ({ ...t, ...c, mode, name: `${c.cls} ${mode} ${t.write}` })))))(
      "refuses a $name write as disk-full, emits the timeout and never fails open",
      async (row) => {
        const o = opts({ headroom: scriptedHeadroomSampler(modes[row.mode]), policy: { heavyCeiling: 1, heavyWarning: 1 }, sessionSlots: 1 });
        const weighted = row.mode === "weight";
        // The ticket is written only by a waiter, so a holder fills the one slot for that row; in weight mode the holder and the request are 8 GiB each, which the 12 GiB budget refuses by weight.
        if (row.write === "ticket") plantHolder(lease, "4242-live", weighted ? { weight: 8 * GIB } : {}, { sub: row.sub });
        const attempted: unknown[] = [];
        restore = failFsCall(
          row.write === "mutex" ? "openSync" : "writeFileSync",
          (p, data) => {
            const hit = row.hit(row, p);
            if (hit && row.write === "ticket") attempted.push(data);
            return hit;
          },
          "ENOSPC",
        );
        const got = await row.acquire(o, weighted ? { ...meta, weight: 8 * GIB } : meta, { maxWaitMs: 1_000 });
        expect(got).toMatchObject({ refused: "disk-full", code: "ENOSPC" });
        expect(lease.events).toContainEqual({ type: "timeout", refused: "disk-full", waitedMs: expect.any(Number), class: row.cls });
        expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
        if (row.write === "ticket") {
          expect(attempted).not.toHaveLength(0);
          // Weight mode must have reached the ticket write with the weight in hand, not failed earlier.
          for (const data of attempted) expect(JSON.parse(String(data))).toMatchObject(weighted ? { weight: 8 * GIB } : {});
          if (!weighted) for (const data of attempted) expect(JSON.parse(String(data))).not.toHaveProperty("weight");
        }
      },
    );

    it("tryAcquireLease emits its own disk-full timeout event on a holder write", () => {
      restore = failFsCall("writeFileSync", (p) => p.includes("/holders/"), "ENOSPC");
      expect(tryAcquireLease(opts(), meta)).toBeNull();
      expect(lease.events).toContainEqual({ type: "timeout", refused: "disk-full", waitedMs: 0, class: "heavy" });
    });
  });

  describe("FIFO tickets", () => {
    it.each<[string, number, { id: string; seq: number; ageMs?: number; dead?: boolean }[], boolean, string[]]>([
      ["no tickets and a free slot", 0, [], true, []],
      ["an eligible ticket ahead, with one free slot", 0, [{ id: "a", seq: 1 }], false, ["a.json"]],
      ["a stale ticket (its waiter stopped), passed over and kept", 0, [{ id: "a", seq: 1, ageMs: TICKET_FRESH_MS + 1_000 }], true, ["a.json"]],
      ["a dead waiter's ticket, reaped", 0, [{ id: "a", seq: 1, dead: true }], true, []],
    ])("with %s", async (_name, holders, planted, admitted, left) => {
      for (let i = 0; i < holders; i++) sessionHolder(`4242-live${i}`);
      for (const t of planted) sessionTicket("sessions-waiting", t.id, t.seq, t);
      const h = await take(at(1));
      expect(h !== undefined).toBe(admitted);
      h?.release();
      expect(names("sessions-waiting")).toEqual(left);
    });

    // The waiters share one fake clock and each sleep a jittered `pollMs`, so the draw decides how far the clock has moved when B re-polls, and A's ticket is passed over once it is older than TICKET_FRESH_MS. At the default 3 s, four sleeps at a high draw pass 15 s; pinning `pollMs` keeps them under 6 s whatever the draw.
    it.each([0, 0.5, 0.999])("admits waiters in the order they arrived, even when the last to arrive polls first (poll jitter draw %s)", async (draw) => {
      vi.spyOn(Math, "random").mockReturnValue(draw);
      const holder = (await take(at(1)))!;
      lease.clock.onSleep = () => holder.release();
      const slowSleep = (yields: number): LeaseOptions["sleep"] => async (ms) => {
        for (let i = 0; i < yields; i++) await new Promise((r) => setImmediate(r));
        await lease.clock.sleep(ms);
      };
      const order: string[] = [];
      const waiter = (name: string, yields: number): Promise<void> =>
        acquireSessionLease(at(1, { sleep: slowSleep(yields), pollMs: 1_000 }), meta).then((r) => {
          order.push(name);
          (r as LeaseHandle).release();
        });
      await Promise.all([waiter("A", 2), waiter("B", 1), waiter("C", 0)]);
      expect(order).toEqual(["A", "B", "C"]);
      expect(names("sessions-waiting")).toEqual([]);
    });

    it("records the inputs of its capacity on the ticket, beside the result", async () => {
      sessionHolder("4242-live");
      const o = opts({ headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }), sessionSlots: 5 });
      const seen: unknown[] = [];
      await acquireSessionLease(o, meta, {
        maxWaitMs: 1,
        onWait: () => seen.push(JSON.parse(readFileSync(join(dir, "sessions-waiting", names("sessions-waiting")[0]!), "utf8"))),
      });
      expect(seen[0]).toMatchObject({ seq: 1, pid: process.pid, capacity: 1, ceiling: 5, override: true });
    });

    it("returns the admission when removing the ticket fails, and leaves no holder behind", async () => {
      const holder = (await take(at(1)))!;
      lease.clock.onSleep = () => holder.release();
      const restore = failFsCall("rmSync", (p) => p.includes("/sessions-waiting/"), "EIO");
      try {
        const r = await acquireSessionLease(at(1), meta);
        expect(r).toMatchObject({ leased: true });
        (r as LeaseHandle).release();
        expect(names("sessions")).toEqual([]);
      } finally {
        restore();
      }
    });

    it("leaves no ticket behind after a stop", async () => {
      sessionHolder("4242-live");
      const r = await acquireSessionLease(opts({ headroom: scriptedHeadroomSampler(reading(0, "critical")) }), meta, { stopWhen: () => true });
      expect(r).toMatchObject({ refused: "stopped", level: "critical" });
      expect(names("sessions-waiting")).toEqual([]);
    });
  });

  describe("a ticket's capacity at the current step", () => {
    const heavy = { acquire: acquireLease, waiting: "waiting", holders: "holders", ceiling: 4 };
    const sessions = { acquire: acquireSessionLease, waiting: "sessions-waiting", holders: "sessions", ceiling: 6 };
    const plantLive = (cls: typeof heavy, n: number): void => {
      for (let i = 0; i < n; i++) plantHolder(lease, `4242-live${i}`, {}, { sub: cls.holders });
    };
    const waiter = async (cls: typeof heavy, o: LeaseOptions): Promise<boolean> => isHandle(await cls.acquire(o, meta, { maxWaitMs: 0 }));

    it.each<[string, typeof heavy, number, number, number]>([
      ["heavy, a rise from step 1 to 2", heavy, 1, 1, 2],
      ["heavy, a rise from step 2 to 3", heavy, 2, 2, 3],
      ["session, a rise from step 1 to 2", sessions, 1, 1, 2],
    ])("keeps an older waiter ahead of a younger one through %s", async (_name, cls, live, recorded, step) => {
      plantLive(cls, live);
      sessionTicket(cls.waiting, "older", 1, { capacity: recorded, ceiling: cls.ceiling });
      expect(await waiter(cls, at(step))).toBe(false);
    });

    it.each([heavy, sessions])("keeps today's rule for a ticket that records no ceiling (%#)", async (cls) => {
      plantLive(cls, 1);
      sessionTicket(cls.waiting, "older", 1, { capacity: 1 });
      expect(await waiter(cls, at(2))).toBe(true);
    });

    it.each([heavy, sessions])("does not hold up a waiter for an owner with a lower ceiling (%#)", async (cls) => {
      plantLive(cls, 1);
      sessionTicket(cls.waiting, "older", 1, { capacity: 1, ceiling: 1 });
      expect(await waiter(cls, at(4))).toBe(true);
    });

    it.each([heavy, sessions])("admits an overridden waiter at step 0 past a capacity-0 ticket (%#)", async (cls) => {
      sessionTicket(cls.waiting, "older", 1, { capacity: 0, ceiling: cls.ceiling });
      expect(await waiter(cls, opts({ headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }) }))).toBe(true);
    });

    it.each([heavy, sessions])("keeps an older overridden waiter ahead of a younger one at step 0 (%#)", async (cls) => {
      sessionTicket(cls.waiting, "older", 1, { capacity: 1, ceiling: cls.ceiling, override: true });
      expect(await waiter(cls, opts({ headroom: scriptedHeadroomSampler(reading(1, "warning"), { overridden: true }) }))).toBe(false);
    });

    it("reads a capacity that is not a number as absent, so the ticket counts", async () => {
      plantLive(heavy, 1);
      sessionTicket(heavy.waiting, "older", 1, { capacity: "0" });
      expect(await waiter(heavy, at(4, { policy: { heavyCeiling: 2, heavyWarning: 1 } }))).toBe(false);
    });
  });

  describe("stopWhen", () => {
    it("passes the session holders and capacity, and confirms a stop through fresh()", async () => {
      sessionHolder("4242-live");
      const seen: unknown[] = [];
      const o = opts({ headroom: scriptedHeadroomSampler(reading(0, "critical")) });
      const r = await acquireSessionLease(o, meta, { stopWhen: (s) => (seen.push({ capacity: s.capacity, live: s.live.map((h) => h.id) }), s.level === "critical") });
      expect(r).toMatchObject({ refused: "stopped", level: "critical", live: 1 });
      expect(seen[0]).toEqual({ capacity: 0, live: ["4242-live"] });
    });

    it("lets a fresh reading delay a stop that a stale cached sample asked for", async () => {
      const o = opts({ headroom: scriptedHeadroomSampler(reading(0, "critical"), { fresh: () => reading(4) }) });
      const r = await acquireSessionLease(o, meta, { maxWaitMs: 0, stopWhen: (s) => s.level === "critical" });
      expect(r).toMatchObject({ refused: "max-wait" });
    });
  });

  describe("holder meta", () => {
    it("writes a heartbeat holder, and no lastAdmit mark, whatever detached or gated the caller passes", async () => {
      const smuggled = { ...meta, detached: { id: "hook-x", sessionPid: 4242, expiresAt: lease.clock.ms + 60_000 }, gated: true, suspendable: true } as HolderMeta;
      const r = await acquireSessionLease(at(4), smuggled, { maxWaitMs: 0 });
      expect(isHandle(r)).toBe(true);
      const [file] = names("sessions");
      const rec = JSON.parse(readFileSync(join(dir, "sessions", file!), "utf8"));
      expect(rec).not.toHaveProperty("expiresAt");
      expect(rec).toMatchObject({ command: "claude -p", cwd: "/work" });
      expect(names("sessions")).toEqual([`${rec.id}.json`]);
      expect(existsSync(join(dir, "lastAdmit"))).toBe(false);
      expect(names(".").filter((n) => n.startsWith("lastAdmit"))).toEqual([]);
      (r as LeaseHandle).release();
    });
  });

  describe("event class", () => {
    it("tells a heavy and a session acquire, release and timeout apart in one event list", async () => {
      const o = at(4, { policy: { heavyCeiling: 4, heavyWarning: 1 } });
      const session = (await acquireSessionLease(o, meta, { maxWaitMs: 0 })) as LeaseHandle;
      const heavyHandle = (await acquireLease(o, meta, { maxWaitMs: 0 })) as LeaseHandle;
      session.release();
      heavyHandle.release();
      const stopped = at(0, { headroom: scriptedHeadroomSampler(reading(0, "critical")) });
      await acquireSessionLease(stopped, meta, { stopWhen: () => true });
      await acquireLease(stopped, meta, { stopWhen: () => true });
      const byType = (type: string) => lease.events.filter((e) => e.type === type).map((e) => (e as { class?: string }).class);
      expect(byType("acquire")).toEqual(["sessions", "heavy"]);
      expect(byType("release")).toEqual(["sessions", "heavy"]);
      expect(byType("timeout")).toEqual(["sessions", "heavy"]);
    });

    it("tags a session reap", async () => {
      sessionHolder("4242-old", {}, HEARTBEAT_STALE_MS + 1_000);
      await take(at(4));
      expect(lease.events).toContainEqual({ type: "reap", id: "4242-old", reason: "stale-heartbeat", class: "sessions" });
    });
  });

  it("exports the session acquire from the barrel", () => {
    expect(barrel.acquireSessionLease).toBe(acquireSessionLease);
  });
});
