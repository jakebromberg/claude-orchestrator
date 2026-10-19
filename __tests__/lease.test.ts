import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLease,
  defaultLeaseOptions,
  leaseStatus,
  releaseHolder,
  tryAcquireLease,
  type HolderMeta,
  type LeaseEvent,
  type LeaseHandle,
  type LeaseOptions,
  type LeaseRefusal,
} from "../src/lease.js";
import * as barrel from "../src/index.js";
import type { PressureLevel } from "../src/memory-pressure.js";
import { scriptedHeadroomSampler, scriptedPressureSampler } from "../src/testing.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import { scriptedLease, unwritableLeaseDir, type FakeLeaseClock, type ScriptedLease } from "./helpers/lease.js";

const meta: HolderMeta = { command: "npm test", cwd: "/work" };
const HEARTBEAT_STALE_MS = 90_000;
const isHandle = (r: LeaseHandle | LeaseRefusal): r is LeaseHandle => "leased" in r;
const realSetInterval = globalThis.setInterval;

describe("lease", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;
  let fake: FakeLeaseClock;
  let level: PressureLevel;
  let freshLevel: PressureLevel | undefined;
  let alive: Set<number>;
  let events: LeaseEvent[];
  let warnings: string[];

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts(over);
  const holderFile = (id: string): string => join(dir, "holders", `${id}.json`);
  const readHolder = (h: LeaseHandle) => JSON.parse(readFileSync(holderFile(h.id!), "utf8"));
  /**
   * Writes a holder file for wrapper PID 4242 (alive only if the test adds it to `alive`), its heartbeat `beatAgoMs` before
   * the injected clock (stale by default). The mtime sits half a millisecond into its millisecond, as real writes do, so the
   * boundary rows pin the floor and not utimes' rounding (Node 20 and 22 truncate to whole microseconds).
   */
  const writeHolder = (id: string, rec: Record<string, unknown>, beatAgoMs = 2 * HEARTBEAT_STALE_MS): void => {
    writeFileSync(holderFile(id), JSON.stringify({ id, pid: 4242, command: "x", cwd: "/", startedAt: fake.ms, level: "normal", ...rec }));
    const beatAt = (fake.ms - beatAgoMs + 0.5) / 1000;
    utimesSync(holderFile(id), beatAt, beatAt);
  };
  /** Creates the lease directory through an acquire (which reaps what it finds), then writes the holder. */
  const plantHolder = (id: string, rec: Record<string, unknown>, beatAgoMs?: number): void => {
    tryAcquireLease(opts({ policy: { heavyCeiling: 99, heavyWarning: 99 } }), meta)!.release();
    writeHolder(id, rec, beatAgoMs);
  };
  const busyMutex = (): void => {
    tryAcquireLease(opts(), meta)!.release();
    writeFileSync(join(dir, ".mutex"), "");
    utimesSync(join(dir, ".mutex"), fake.ms / 1000, fake.ms / 1000); // fresh on the injected clock, not from its future
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-"));
    dir = join(tmp, "lease");
    level = "normal";
    freshLevel = undefined;
    lease = scriptedLease(dir, { level: () => level, fresh: () => freshLevel ?? level, policy: { heavyCeiling: 2, heavyWarning: 1 } });
    ({ clock: fake, alive, events, warnings } = lease);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
    // A later test's holder must start a real heartbeat timer, not a fake left behind by a spy.
    expect(globalThis.setInterval).toBe(realSetInterval);
  });

  describe("admission", () => {
    it("admits up to capacity, refuses the next, and a release frees a slot", () => {
      const a = tryAcquireLease(opts(), meta)!;
      const b = tryAcquireLease(opts(), meta)!;
      expect([a.leased, b.leased]).toEqual([true, true]);
      expect(tryAcquireLease(opts(), meta)).toBeNull();
      a.release({ exitCode: 0 });
      const c = tryAcquireLease(opts(), meta);
      expect(c?.leased).toBe(true);
      expect(events.filter((e) => e.type === "release")).toEqual([{ type: "release", id: a.id, heldMs: 0, exitCode: 0 }]);
      b.release();
      c!.release();
    });

    it("scales capacity with the pressure level and refuses everything at critical", () => {
      level = "warning";
      const a = tryAcquireLease(opts(), meta)!;
      expect(tryAcquireLease(opts(), meta)).toBeNull();
      a.release();
      level = "critical";
      expect(tryAcquireLease(opts(), meta)).toBeNull();
    });

    it("wakes a waiter when a holder releases", async () => {
      const a = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      fake.onSleep = () => a.release();
      const r = await acquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta);
      expect(isHandle(r) && r.leased).toBe(true);
      expect(fake.sleeps).toHaveLength(1);
      expect(fake.sleeps[0]).toBeGreaterThanOrEqual(2_000);
      expect(fake.sleeps[0]).toBeLessThanOrEqual(4_000);
      expect((r as LeaseHandle).admission.waitedMs).toBe(fake.sleeps[0]);
    });

    it("passes onWait the wait measured on the injected clock, as the admission reports it", async () => {
      const a = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      fake.onSleep = () => { if (fake.sleeps.length === 3) a.release(); };
      const seen: number[] = [];
      const r = await acquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta, { onWait: (s) => seen.push(s.waitedMs) });
      const elapsed = fake.sleeps.map((_, i) => fake.sleeps.slice(0, i).reduce((x, y) => x + y, 0));
      expect(seen).toEqual(elapsed.slice(0, 3));
      expect((r as LeaseHandle).admission.waitedMs).toBe(fake.sleeps.reduce((x, y) => x + y, 0));
    });

    it("records the wait, level, live count (including itself) and capacity at admission", () => {
      tryAcquireLease(opts(), meta);
      const b = tryAcquireLease(opts(), meta)!;
      expect(b.admission).toEqual({ waitedMs: 0, level: "normal", live: 2, capacity: 2 });
      expect(events.find((e) => e.type === "acquire" && e.id === b.id)).toMatchObject({ live: 2, capacity: 2 });
    });

    it("records the holder and reports it through leaseStatus", () => {
      const h = tryAcquireLease(opts(), { command: "npm test", cwd: "/work" })!;
      expect(readHolder(h)).toEqual({ id: h.id, pid: process.pid, command: "npm test", cwd: "/work", startedAt: fake.ms, level: "normal" });
      h.setChildPid(777);
      expect(readHolder(h).childPid).toBe(777);
      const status = leaseStatus(opts());
      expect(status).toMatchObject({ level: "normal", capacity: 2 });
      expect(status.live).toMatchObject([{ id: h.id, pid: process.pid, command: "npm test", ageSec: 0 }]);
      h.release();
      expect(leaseStatus(opts()).live).toEqual([]);
    });

    it("records the suspendable mark and the command's process group on the holder", () => {
      const h = tryAcquireLease(opts(), { ...meta, suspendable: true })!;
      h.setChildPid(777, 778);
      expect(readHolder(h)).toMatchObject({ childPid: 777, pgid: 778, suspendable: true });
      const plain = tryAcquireLease(opts(), meta)!;
      plain.setChildPid(779, 0);
      expect(readHolder(plain)).not.toHaveProperty("pgid");
      expect(readHolder(plain)).not.toHaveProperty("suspendable");
    });

    it.each([0, -1, NaN, 1.5])("ignores setChildPid(%s), so its own live holder is not reaped as corrupt", (pid) => {
      const one = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } });
      const h = tryAcquireLease(one, meta)!;
      h.setChildPid(pid);
      expect(tryAcquireLease(one, meta)).toBeNull();
      expect(events.filter((e) => e.type === "reap")).toEqual([]);
      h.release();
    });

    it("ignores setChildPid after release, so no holder file comes back", () => {
      const h = tryAcquireLease(opts(), meta)!;
      h.release();
      h.setChildPid(12345);
      expect(existsSync(holderFile(h.id!))).toBe(false);
      expect(leaseStatus(opts()).live).toEqual([]);
    });

    it.each([
      ["onEvent", { onEvent: () => { throw new Error("sink down"); } }],
      ["warn", { warn: () => { throw new Error("stderr closed"); } }],
    ] as const)("keeps its behaviour when %s throws", (name, callbacks) => {
      alive.add(900);
      plantHolder("4242-ab01", { childPid: 900, startedAt: fake.ms - 3 * 3_600_000 }); // orphan-bound: warns
      writeHolder("4242-ab02", {}); // stale-heartbeat
      const o = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 }, ...callbacks });
      const h = tryAcquireLease(o, meta)!;
      expect(h.leased).toBe(true);
      expect(existsSync(holderFile("4242-ab01"))).toBe(false);
      expect(existsSync(holderFile("4242-ab02"))).toBe(false);
      h.release();
      expect(tryAcquireLease(o, meta)?.leased).toBe(true);
      if (name === "onEvent") expect(warnings.filter((w) => w.includes("threw"))).toHaveLength(1);
    });

    it("calls back only after releasing the mutex, so a slow callback cannot let a second acquirer in", () => {
      alive.add(900);
      plantHolder("4242-ab03", { childPid: 900, startedAt: fake.ms - 3 * 3_600_000 }); // orphan-bound: warns and reaps
      const one = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } });
      const mutexHeld: boolean[] = [];
      let second: LeaseHandle | null | undefined;
      const slow = (): void => {
        mutexHeld.push(existsSync(join(dir, ".mutex")));
        fake.ms += 11_000; // outlives the mutex's 10 s staleness window
        if (second === undefined) second = tryAcquireLease(one, meta);
      };
      const first = tryAcquireLease({ ...one, onEvent: slow, warn: slow }, meta);
      expect({ first: first?.leased, second, mutexHeld }).toEqual({ first: true, second: null, mutexHeld: [false, false, false] });
      expect(leaseStatus(opts()).live).toHaveLength(1);
    });

    it("measures capped waiters starving behind uncapped ones (admission is not FIFO)", () => {
      const held = [tryAcquireLease(opts(), meta)!, tryAcquireLease(opts(), meta)!];
      const cappedLevel = { level: scriptedPressureSampler("warning") };
      let capped = 0;
      let uncapped = 0;
      for (let round = 0; round < 10; round++) {
        held.shift()!.release();
        if (tryAcquireLease(opts(cappedLevel), meta)) capped++;
        const u = tryAcquireLease(opts(), meta);
        if (u) {
          uncapped++;
          held.push(u);
        }
      }
      expect({ capped, uncapped }).toEqual({ capped: 0, uncapped: 10 });
    });
  });

  describe("liveness", () => {
    // [description, heartbeat age ms, child alive? (undefined: no child), started ms ago, still live?]
    it.each([
      ["a fresh heartbeat with no child", 10_000, undefined, 10_000, true],
      ["a fresh heartbeat whose child is dead", 10_000, false, 60_000, true],
      ["a fresh heartbeat with a live child past the 2 h bound (the wrapper is alive)", 10_000, true, 3 * 3_600_000, true],
      ["a stale heartbeat with a live child (killed wrapper keeps its slot)", 120_000, true, 60_000, true],
      ["a stale heartbeat with a dead child", 120_000, false, 60_000, false],
      ["a stale heartbeat with no child", 120_000, undefined, 60_000, false],
      ["a stale heartbeat with a live child past the 2 h bound", 120_000, true, 3 * 3_600_000, false],
      ["a stale heartbeat with a live child dated 1 h in the future (a clock step)", 120_000, true, -3_600_000, true],
      ["a stale heartbeat with a live child dated past the 2 h bound in the future", 120_000, true, -3 * 3_600_000, false],
      ["a heartbeat exactly at the 90 s window", HEARTBEAT_STALE_MS, false, 60_000, true],
      ["a heartbeat 1 ms past the 90 s window", HEARTBEAT_STALE_MS + 1, false, 60_000, false],
      ["a heartbeat dated 30 s in the future (a small clock step back)", -30_000, undefined, 60_000, true],
      ["a heartbeat dated exactly 90 s in the future", -HEARTBEAT_STALE_MS, undefined, 60_000, true],
      ["a heartbeat dated 1 ms past the window in the future", -HEARTBEAT_STALE_MS - 1, undefined, 60_000, false],
      ["a far-future heartbeat with a live child", -3_600_000, true, 60_000, true],
    ])("%s", (_name, beatAgo, childAlive, startedAgo, stillLive) => {
      if (childAlive) alive.add(900);
      plantHolder("4242-aaaa", { childPid: childAlive === undefined ? undefined : 900, startedAt: fake.ms - startedAgo }, beatAgo);
      const h = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta);
      expect(h === null).toBe(stillLive);
      expect(existsSync(holderFile("4242-aaaa"))).toBe(stillLive);
      expect(leaseStatus(opts()).live.some((x) => x.id === "4242-aaaa")).toBe(stillLive);
    });

    it.each([
      ["a stale heartbeat", 120_000, false],
      ["a fresh heartbeat", 10_000, true],
    ])("keeps a reused wrapper PID only while the heartbeat is fresh (%s)", (_name, beatAgo, stillLive) => {
      alive.add(4242); // the OS gave the dead wrapper's PID to an unrelated process
      plantHolder("4242-aaab", {}, beatAgo);
      expect(leaseStatus(opts()).live.some((x) => x.id === "4242-aaab")).toBe(stillLive);
    });

    it("reports a stale heartbeat with no live child as a stale-heartbeat reap", () => {
      plantHolder("4242-aaac", {});
      tryAcquireLease(opts(), meta)!.release();
      expect(events).toContainEqual({ type: "reap", id: "4242-aaac", reason: "stale-heartbeat" });
    });

    describe("heartbeat", () => {
      const mtimeOf = (h: LeaseHandle): number => statSync(holderFile(h.id!)).mtimeMs;
      /** Advances the injected clock and the fake timers together. */
      const tick = (ms: number): void => {
        fake.ms += ms;
        vi.advanceTimersByTime(ms);
      };

      it("refreshes the holder file's mtime every 30 s, keeping the holder live past 90 s", () => {
        vi.useFakeTimers();
        const h = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
        const written = mtimeOf(h);
        tick(29_999);
        expect(mtimeOf(h)).toBe(written);
        tick(1);
        expect(Math.abs(mtimeOf(h) - fake.ms)).toBeLessThan(1);
        for (let i = 0; i < 5; i++) tick(30_000);
        expect(Math.abs(mtimeOf(h) - fake.ms)).toBeLessThan(1);
        expect(leaseStatus(opts()).live.map((x) => x.id)).toEqual([h.id]);
        h.release();
      });

      it("starts an unref'd timer at admission", () => {
        // Under real timers on purpose: Vitest 3 re-runs every spy's restore at each later restoreAllMocks, so a spy
        // made under fake timers would put that dead fake setInterval back for every later test in this file.
        const setInterval = vi.spyOn(globalThis, "setInterval");
        const h = tryAcquireLease(opts(), meta)!;
        expect((setInterval.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false);
        h.release();
      });

      it("clears the timer at release, so nothing rewrites the file", () => {
        vi.useFakeTimers();
        const h = tryAcquireLease(opts(), meta)!;
        expect(vi.getTimerCount()).toBe(1);
        h.release();
        expect(vi.getTimerCount()).toBe(0);
        writeHolder(h.id!, {}, 120_000); // a file at the old path must stay as it was
        const before = mtimeOf(h);
        tick(60_000);
        expect(mtimeOf(h)).toBe(before);
      });

      it("leaves a holder file reaped between beats gone", () => {
        vi.useFakeTimers();
        const h = tryAcquireLease(opts(), meta)!;
        rmSync(holderFile(h.id!));
        expect(() => tick(30_000)).not.toThrow();
        expect(existsSync(holderFile(h.id!))).toBe(false);
        h.release();
      });

      it("keeps a holder reaped while it still runs out of the count, even when it then records a child", () => {
        const one = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } });
        const a = tryAcquireLease(one, meta)!;
        const stalled = (fake.ms - (HEARTBEAT_STALE_MS + 10_000) + 0.5) / 1000; // its event loop missed every beat
        utimesSync(holderFile(a.id!), stalled, stalled);
        const b = tryAcquireLease(one, meta)!;
        expect(events).toContainEqual({ type: "reap", id: a.id, reason: "stale-heartbeat" });
        a.setChildPid(4321);
        expect(existsSync(holderFile(a.id!))).toBe(false);
        expect(leaseStatus(one).live.map((x) => x.id)).toEqual([b.id]);
        a.release();
        b.release();
      });
    });

    it("reaps an orphan past the bound with a warning and an event", () => {
      alive.add(900);
      plantHolder("4242-bbbb", { childPid: 900, startedAt: fake.ms - 3 * 3_600_000 });
      tryAcquireLease(opts(), meta)!.release();
      expect(warnings.join("\n")).toMatch(/4242-bbbb.*2 h orphan bound/);
      expect(events).toContainEqual({ type: "reap", id: "4242-bbbb", reason: "orphan-bound" });
    });

    it.each([
      ["unparseable JSON", "{not json"],
      ["JSON null", "null"],
      ["a record with no pid", JSON.stringify({ id: "4242-cccc", startedAt: 1 })],
      ["a record with no startedAt", JSON.stringify({ id: "4242-cccc", pid: 4242 })],
      ["pid 0", JSON.stringify({ id: "4242-cccc", pid: 0, startedAt: 1 })],
      ["pid -1", JSON.stringify({ id: "4242-cccc", pid: -1, startedAt: 1 })],
      ["a non-integer pid", JSON.stringify({ id: "4242-cccc", pid: 4242.5, startedAt: 1 })],
      ["childPid 0", JSON.stringify({ id: "4242-cccc", pid: 4242, childPid: 0, startedAt: 1 })],
      ["childPid -1", JSON.stringify({ id: "4242-cccc", pid: 4242, childPid: -1, startedAt: 1 })],
    ])("reaps a holder file holding %s as corrupt", (_name, text) => {
      alive.add(0).add(-1); // as the real kill(pid, 0) sees them: the process group, and every process
      plantHolder("4242-cccc", {});
      writeFileSync(holderFile("4242-cccc"), text);
      tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      expect(events).toContainEqual({ type: "reap", id: "4242-cccc", reason: "corrupt" });
      expect(existsSync(holderFile("4242-cccc"))).toBe(false);
    });

    it("skips a holder file that is gone by the time it is read, without reporting a reap", () => {
      plantHolder("4242-cccd", {});
      rmSync(holderFile("4242-cccd"));
      symlinkSync(join(tmp, "missing"), holderFile("4242-cccd")); // listed by readdir, ENOENT on read
      expect(tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)?.leased).toBe(true);
      expect(events.filter((e) => e.type === "reap")).toEqual([]);
    });

    it.skipIf(process.getuid?.() === 0)("keeps a holder file it cannot read, failing open instead of reaping it", () => {
      plantHolder("4242-ccce", {});
      chmodSync(holderFile("4242-ccce"), 0o000);
      expect(tryAcquireLease(opts(), meta)).toMatchObject({ leased: false, id: null });
      expect(existsSync(holderFile("4242-ccce"))).toBe(true);
      expect(events.filter((e) => e.type === "reap")).toEqual([]);
      expect(leaseStatus(opts()).live).toEqual([]);
    });

    it("does not reap from leaseStatus", () => {
      plantHolder("4242-dddd", {});
      expect(leaseStatus(opts()).live).toEqual([]);
      expect(existsSync(holderFile("4242-dddd"))).toBe(true);
    });
  });

  describe("detached holders", () => {
    const SESSION = 7001;
    const detached = (over: Partial<NonNullable<HolderMeta["detached"]>> = {}): HolderMeta => ({
      ...meta,
      detached: { id: "hook-toolu_1", sessionPid: SESSION, expiresAt: fake.ms + 180_000, ...over },
    });
    const one = { policy: { heavyCeiling: 1, heavyWarning: 1 } };

    it("records the given id, the session PID and expiresAt, and starts no heartbeat", () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      const h = tryAcquireLease(opts(), detached())!;
      expect(h.id).toBe("hook-toolu_1");
      expect(readHolder(h)).toMatchObject({ id: "hook-toolu_1", pid: SESSION, expiresAt: fake.ms + 180_000, startedAt: fake.ms });
      expect(spy).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({ type: "acquire", id: "hook-toolu_1" }));
    });

    // [description, session alive?, expiresAt offset ms from now, still live? / reap reason, heartbeat age ms]
    it.each<[string, boolean, number, "live" | "dead-session" | "expired", number]>([
      ["a live session before expiresAt", true, 60_000, "live", 10_000],
      ["a live session whose heartbeat is long stale (the heartbeat rule never applies)", true, 60_000, "live", 10 * HEARTBEAT_STALE_MS],
      ["a dead session before expiresAt", false, 60_000, "dead-session", 0],
      ["a live session at expiresAt", true, 0, "expired", 0],
      ["a live session 1 ms before expiresAt", true, 1, "live", 0],
      ["a live session past expiresAt", true, -1, "expired", 0],
      ["a live session exactly 660 s before expiresAt", true, 660_000, "live", 0],
      ["a live session 750 s before expiresAt (the 660 s cap plus 90 s for a backward clock step)", true, 750_000, "live", 0],
      ["a live session with expiresAt 1 ms past the 750 s bound", true, 750_001, "expired", 0],
    ])("%s", (_name, sessionAlive, expiresIn, expected, beatAgo) => {
      if (sessionAlive) alive.add(SESSION);
      plantHolder("hook-x", { pid: SESSION, expiresAt: fake.ms + expiresIn }, beatAgo);
      expect(leaseStatus(opts()).live.some((x) => x.id === "hook-x")).toBe(expected === "live");
      tryAcquireLease(opts(), meta)!.release();
      expect(events.filter((e) => e.type === "reap")).toEqual(expected === "live" ? [] : [{ type: "reap", id: "hook-x", reason: expected }]);
      expect(existsSync(holderFile("hook-x"))).toBe(expected === "live");
    });

    it.each([["a string", "soon"], ["NaN", null], ["a boolean", true]])("reaps a holder whose expiresAt is %s as corrupt", (_n, expiresAt) => {
      plantHolder("hook-y", { pid: SESSION, expiresAt });
      alive.add(SESSION);
      tryAcquireLease(opts(), meta)!.release();
      expect(events).toContainEqual({ type: "reap", id: "hook-y", reason: "corrupt" });
    });

    it("counts a live detached holder against capacity", () => {
      alive.add(SESSION);
      tryAcquireLease(opts(one), detached())!;
      expect(tryAcquireLease(opts(one), meta)).toBeNull();
    });

    it("admits a second acquire of a live detached id at once, at capacity 1, with one holder file and one acquire event", async () => {
      alive.add(SESSION);
      const first = tryAcquireLease(opts(one), detached())!;
      const sleep = vi.fn(async () => {});
      const second = await acquireLease(opts({ ...one, sleep }), detached(), { maxWaitMs: 0 });
      expect(second).toMatchObject({ id: "hook-toolu_1", leased: true, admission: { waitedMs: 0, live: 1, capacity: 1 } });
      expect(sleep).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "holders"))).toEqual(["hook-toolu_1.json"]);
      expect(events.filter((e) => e.type === "acquire")).toHaveLength(1);
      expect(tryAcquireLease(opts(one), { ...meta, detached: { ...detached().detached!, id: "hook-other" } })).toBeNull();
      (second as LeaseHandle).release();
      expect(existsSync(holderFile("hook-toolu_1"))).toBe(true);
      first.release();
      expect(existsSync(holderFile("hook-toolu_1"))).toBe(false);
    });

    it("does not treat a dead detached holder with the requested id as admitted", () => {
      plantHolder("hook-toolu_1", { pid: SESSION, expiresAt: fake.ms + 60_000 });
      const h = tryAcquireLease(opts(one), detached())!;
      expect(readHolder(h)).toMatchObject({ id: "hook-toolu_1", startedAt: fake.ms });
      expect(events).toContainEqual({ type: "reap", id: "hook-toolu_1", reason: "dead-session" });
    });

    it.each(["../escaped", "a/b", "a.b", ""])("refuses the detached id %j before taking a slot or writing anything", async (id) => {
      expect(() => tryAcquireLease(opts(), detached({ id }))).toThrow(TypeError);
      await expect(acquireLease(opts(), detached({ id }))).rejects.toThrow(TypeError);
      expect(existsSync(dir)).toBe(false);
      expect(events).toEqual([]);
    });

    it.each<[string, Partial<NonNullable<HolderMeta["detached"]>>]>([
      ["an id of 161 characters", { id: "a".repeat(161) }],
      ["a session PID of 0", { sessionPid: 0 }],
      ["a negative session PID", { sessionPid: -1 }],
      ["a fractional session PID", { sessionPid: 1.5 }],
      ["a session PID of 2^31, which process.kill rejects", { sessionPid: 2 ** 31 }],
      ["a NaN expiresAt", { expiresAt: NaN }],
      ["an infinite expiresAt", { expiresAt: Infinity }],
    ])("throws a TypeError for %s, before taking a slot or writing anything", async (_name, over) => {
      expect(() => tryAcquireLease(opts(), detached(over))).toThrow(TypeError);
      await expect(acquireLease(opts(), detached(over))).rejects.toThrow(TypeError);
      expect(existsSync(dir)).toBe(false);
    });

    it("accepts an id of 160 characters, and releases it", () => {
      const id = "a".repeat(160);
      expect(tryAcquireLease(opts(), detached({ id }))?.id).toBe(id);
      expect(releaseHolder(opts(), id)).toBe(true);
      expect(releaseHolder(opts(), "a".repeat(300))).toBe(false);
    });

    describe("releaseHolder", () => {
      it("removes the holder and emits one release with heldMs", () => {
        tryAcquireLease(opts(), detached());
        fake.ms += 4_000;
        expect(releaseHolder(opts(), "hook-toolu_1")).toBe(true);
        expect(existsSync(holderFile("hook-toolu_1"))).toBe(false);
        expect(events.filter((e) => e.type === "release")).toEqual([{ type: "release", id: "hook-toolu_1", heldMs: 4_000 }]);
      });

      it("is idempotent: a holder that is already gone returns false and emits nothing", () => {
        tryAcquireLease(opts(), meta)!.release();
        events.length = 0;
        expect(releaseHolder(opts(), "hook-nope")).toBe(false);
        expect(releaseHolder(opts({ dir: join(tmp, "never") }), "hook-nope")).toBe(false);
        expect(events).toEqual([]);
      });

      it.each(["../victim", "a/b", "a.b", ""])("treats the id %j as naming no holder, and removes nothing outside holders/", (id) => {
        tryAcquireLease(opts(), meta)!.release();
        writeFileSync(join(dir, "victim.json"), "{}");
        expect(releaseHolder(opts(), id)).toBe(false);
        expect(existsSync(join(dir, "victim.json"))).toBe(true);
        expect(events.filter((e) => e.type === "release")).toHaveLength(1);
      });

      // A wrapper's own heartbeating holder, or a file the reaper owns, is never released by id.
      it.each<[string, () => string]>([
        ["a wrapper holder", () => tryAcquireLease(opts(), meta)!.id!],
        ["a file that is not a valid record", () => (tryAcquireLease(opts(), meta)!.release(), writeFileSync(holderFile("hook-bad"), "{not json"), "hook-bad")],
      ])("leaves %s alone: returns false and emits nothing", (_name, plant) => {
        const id = plant();
        events.length = 0;
        expect(releaseHolder(opts(), id)).toBe(false);
        expect(existsSync(holderFile(id))).toBe(true);
        expect(events).toEqual([]);
      });

      it("does not follow a holders directory that is a symlink", () => {
        const elsewhere = join(tmp, "elsewhere");
        mkdirSync(elsewhere, { mode: 0o700 });
        writeFileSync(join(elsewhere, "hook-x.json"), JSON.stringify({ id: "hook-x", pid: SESSION, command: "npm test", cwd: "/", startedAt: fake.ms, expiresAt: fake.ms + 60_000, level: "normal" }));
        mkdirSync(dir, { mode: 0o700 });
        symlinkSync(elsewhere, join(dir, "holders"));
        expect(releaseHolder(opts(), "hook-x")).toBe(false);
        expect(existsSync(join(elsewhere, "hook-x.json"))).toBe(true);
      });

      it("does not follow a lease directory that is a symlink", () => {
        const elsewhere = join(tmp, "elsewhere");
        mkdirSync(join(elsewhere, "holders"), { recursive: true, mode: 0o700 });
        writeFileSync(join(elsewhere, "holders", "hook-x.json"), JSON.stringify({ id: "hook-x", pid: SESSION, command: "npm test", cwd: "/", startedAt: fake.ms, expiresAt: fake.ms + 60_000, level: "normal" }));
        symlinkSync(elsewhere, dir);
        expect(releaseHolder(opts(), "hook-x")).toBe(false);
        expect(existsSync(join(elsewhere, "holders", "hook-x.json"))).toBe(true);
        expect(events.filter((e) => e.type === "release")).toEqual([]);
      });
    });
  });

  describe("mutex and fail-open", () => {
    it("treats a busy mutex as not admitted, without throwing", () => {
      busyMutex();
      expect(tryAcquireLease(opts(), meta)).toBeNull();
    });

    it("fails open after 30 s of a busy mutex, with one warning", async () => {
      busyMutex();
      // Keep the mutex fresh on the injected clock so it never reads as stale.
      fake.onSleep = () => utimesSync(join(dir, ".mutex"), fake.ms / 1000, fake.ms / 1000);
      const r = await acquireLease(opts(), meta);
      expect(r).toMatchObject({ leased: false, id: null });
      expect(fake.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
      expect(warnings).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "fail-open", reason: "mutex-busy" }));
    });

    it("never fails open at critical: a busy mutex stays no free slot until maxWaitMs", async () => {
      busyMutex();
      level = "critical";
      fake.onSleep = () => utimesSync(join(dir, ".mutex"), fake.ms / 1000, fake.ms / 1000);
      const r = await acquireLease(opts(), meta, { maxWaitMs: 60_000 });
      expect(r).toMatchObject({ refused: "max-wait", level: "critical" });
      expect(warnings).toEqual([]);
    });

    it("reaps a stale mutex left by a killed holder", () => {
      busyMutex();
      const old = (fake.ms - 20_000) / 1000;
      utimesSync(join(dir, ".mutex"), old, old);
      expect(tryAcquireLease(opts(), meta)?.leased).toBe(true);
    });

    it("fails open on an unwritable directory, but counts it as no free slot at critical", () => {
      const unwritable = { dir: unwritableLeaseDir(tmp) };
      const h = tryAcquireLease(opts(unwritable), meta)!;
      expect(h).toMatchObject({ leased: false, id: null });
      expect(h.childEnv()).toEqual({});
      expect(warnings).toHaveLength(1);
      level = "critical";
      expect(tryAcquireLease(opts(unwritable), meta)).toBeNull();
    });

    it("acquireLease fails open at once on an unwritable directory below critical", async () => {
      expect(await acquireLease(opts({ dir: unwritableLeaseDir(tmp) }), meta)).toMatchObject({ leased: false });
    });
  });

  describe("directory", () => {
    it.each([
      ["creates the directory with mode 0700 at the first acquire", undefined],
      ["tightens an existing directory this user owns to 0700", 0o777],
    ])("%s", (_name, mode) => {
      if (mode) {
        mkdirSync(join(dir, "holders"), { recursive: true });
        chmodSync(dir, mode);
        chmodSync(join(dir, "holders"), mode);
      }
      expect(tryAcquireLease(opts(), meta)?.leased).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "holders")).mode & 0o777).toBe(0o700);
    });

    it.each([
      ["the lease directory is a symlink", () => symlinkSync(join(tmp, "elsewhere"), dir)],
      ["the holders directory is a symlink", () => (mkdirSync(dir, { mode: 0o700 }), symlinkSync(join(tmp, "elsewhere"), join(dir, "holders")))],
      ["the lease directory is another user's", () => (mkdirSync(dir, { mode: 0o700 }), vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValue(statSync(dir).uid + 1))],
    ])("fails open when %s, writing nothing, and counts it as no free slot at critical", (_name, plant) => {
      mkdirSync(join(tmp, "elsewhere"), { mode: 0o700 });
      plant();
      expect(tryAcquireLease(opts(), meta)).toMatchObject({ leased: false, id: null });
      expect(readdirSync(join(tmp, "elsewhere"))).toEqual([]);
      level = "critical";
      expect(tryAcquireLease(opts(), meta)).toBeNull();
    });

    it("skips the ownership check on a platform without uids", () => {
      const { getuid } = process;
      process.getuid = undefined;
      try {
        expect(tryAcquireLease(opts(), meta)?.leased).toBe(true);
      } finally {
        process.getuid = getuid;
      }
    });

    it("is not created by defaultLeaseOptions() or leaseStatus", () => {
      const lease = join(tmp, "never");
      const o = defaultLeaseOptions({ CO_LEASE_DIR: lease, HOME: tmp });
      expect(o.dir).toBe(lease);
      leaseStatus({ ...o, level: scriptedPressureSampler("normal"), headroom: scriptedHeadroomSampler({ level: "normal", step: 4, signals: null }) });
      expect(existsSync(lease)).toBe(false);
    });

    it("wires the environment into defaultLeaseOptions", () => {
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "3", CO_LEASE_HOLDER: "1-ab", CO_PRESSURE_OVERRIDE: "critical-as-warning" });
      expect(o).toMatchObject({ dir, policy: { heavyCeiling: 3 }, inheritedHolderId: "1-ab" });
      expect(typeof o.onEvent).toBe("function");
      expect(typeof o.level.overridden).toBe("function");
      expect(defaultLeaseOptions({ CO_LEASE_DIR: dir })).toMatchObject({ inheritedHolderId: undefined });
    });
  });

  describe("defaultLeaseOptions overrides", () => {
    const sampler = scriptedPressureSampler("normal", { overridden: false });

    it.each<[string, Record<string, string>]>([
      ["an empty environment", {}],
      ["a slot ceiling", { CO_LEASE_SLOTS: "2" }],
      ["the pressure override", { CO_PRESSURE_OVERRIDE: "critical-as-warning" }],
    ])("always sets a headroom sampler without a level override (%s)", (_name, env) => {
      expect(typeof defaultLeaseOptions({ CO_LEASE_DIR: dir, ...env }).headroom).toBe("function");
    });

    it("uses the caller's sampler instead of building a second one", () => {
      expect(defaultLeaseOptions({ CO_LEASE_DIR: dir }, { level: sampler }).level).toBe(sampler);
    });

    it("sends every diagnostic to the one warn and writes nothing to stderr", async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      const w = vi.fn<(msg: string) => void>();
      // A rotation that fails: the sink's rename onto a non-empty directory.
      mkdirSync(join(dir, "events.jsonl.1", "occupied"), { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "x".repeat(6 * 1024 * 1024));
      const rotating = defaultLeaseOptions({ CO_LEASE_DIR: dir, HOME: tmp }, { level: sampler, warn: w });
      rotating.onEvent!({ type: "reap", id: "9-zz", reason: "corrupt" });
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/^lease: cannot rotate/));
      rmSync(dir, { recursive: true, force: true });

      // An invalid CO_LEASE_SLOTS.
      defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "many" }, { level: sampler, warn: w });
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/CO_LEASE_SLOTS/));

      // An orphan-bound reap, then an I/O fail-open.
      const o = { ...defaultLeaseOptions({ CO_LEASE_DIR: dir }, { level: sampler, warn: w }), now: fake.now, isAlive: opts().isAlive };
      alive.add(900);
      plantHolder("4242-ab01", { childPid: 900, startedAt: fake.ms - 3 * 3_600_000 });
      tryAcquireLease(o, meta)!.release();
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/^lease: reaping holder 4242-ab01/));
      ((await acquireLease({ ...o, dir: unwritableLeaseDir(tmp) }, meta)) as LeaseHandle).release();
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/^lease: unavailable \(io-error\)/));
      expect(stderr).not.toHaveBeenCalled();
    });

    it("never lets a throwing injected writer change what the policy, sampler or sink does", async () => {
      const w = vi.fn(() => {
        throw new Error("sink closed");
      });
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "many", CO_PRESSURE_OVERRIDE: "nope" }, { warn: w, level: sampler });
      expect(w).toHaveBeenCalled();
      expect(o.policy).toEqual({ heavyCeiling: 4, heavyWarning: 1 });
      // The sink: a failed rotation makes it call the throwing writer, and the event is still appended.
      mkdirSync(join(dir, "events.jsonl.1", "occupied"), { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), "x".repeat(6 * 1024 * 1024));
      w.mockClear();
      o.onEvent!({ type: "reap", id: "9-zz", reason: "corrupt" });
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/^lease: cannot rotate/));
      expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain('"id":"9-zz"');
      rmSync(dir, { recursive: true, force: true });
      // The sampler, with its invalid override, still answers, and the lease still fails open.
      const real = defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_PRESSURE_OVERRIDE: "nope" }, { warn: w });
      expect(() => real.level()).not.toThrow();
      const h = (await acquireLease({ ...o, dir: unwritableLeaseDir(tmp) }, meta)) as LeaseHandle;
      expect(h.leased).toBe(false);
      expect(w).toHaveBeenCalledWith(expect.stringMatching(/^lease: unavailable \(io-error\)/));
      h.release();
    });

    it("tags the policy's and sampler's lines with 'memory-pressure:' so each is identifiable", () => {
      const w = vi.fn();
      defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "many", CO_PRESSURE_OVERRIDE: "nope" }, { warn: w })?.level();
      const lines = w.mock.calls.map(([m]) => String(m));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.every((l) => /^(memory-pressure|lease): /.test(l))).toBe(true);
    });

    it("prints no default line that starts with '[lease] lease:'", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "many" }, { level: sampler });
      const h = (await acquireLease({ ...o, dir: unwritableLeaseDir(tmp) }, meta)) as LeaseHandle;
      expect(h.leased).toBe(false);
      h.release();
      const lines = stderr.mock.calls.map(([c]) => String(c));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.filter((l) => l.startsWith("[lease] lease:"))).toEqual([]);
    });
  });

  describe("recorded command", () => {
    const MARK = "hunter2";
    const recordedFor = (command: string, label?: string): string => {
      const h = tryAcquireLease(opts(), { command, label, cwd: "/w" })!;
      const recorded = readHolder(h).command as string;
      h.release();
      return recorded;
    };

    it.each([
      ["DATABASE_URL_TEST=postgres://u:hunter2@h/db npm test", "DATABASE_URL_TEST=…"],
      ["cd x && npm test", "cd x && npm test"],
      ["npm test --reporter=dot", "npm test --reporter=…"],
      [`env "TOKEN=abc"'hunter2' npm`, `env "TOKEN=…`],
      ["env $'TOKEN=hunter2' npm test", "env $'TOKEN=…"],
      [`docker build --build-arg="NPM_TOKEN=hunter2" .`, "docker build --build-arg=…"],
      [String.raw`bash -lc "cd db && PGPASSWORD=\"hunter2 x\" psql"`, `bash -lc "cd db && PGPASSWORD=…`],
      [`"$X"=hunter2 npm test`, `"$X"=…`],
      ["X[0]=hunter2 npm test", "X[0]=…"],
      ["TOKEN\\=hunter2 npm test", "TOKEN\\=…"],
      ["npm ci\nTOKEN=hunter2 npm test", "npm ci\nTOKEN=…"],
      ["git clone https://u:hunter2@h/r", "git clone https://…"],
      ["psql postgres://u:hunter2@h/db", "psql postgres://…"],
      ["curl https://u:hunter2@h/x?a=1", "curl https://…"],
    ])("records %j as %j", (command, expected) => {
      const recorded = recordedFor(command);
      expect(recorded).toBe(expected);
      expect(recorded).not.toContain(MARK);
    });

    it("truncates a command with no = or :// to 200 characters", () => {
      expect(recordedFor("x".repeat(500))).toBe("x".repeat(200));
    });

    it("truncates after the cut, so a late = never brings its value back", () => {
      const recorded = recordedFor(`${"x".repeat(300)}=hunter2`);
      expect(recorded).toHaveLength(200);
      expect(recorded).not.toContain("=");
    });

    it("records a caller-supplied label verbatim instead of the command", () => {
      expect(recordedFor("SECRET=1 npm test", "unit tests")).toBe("unit tests");
    });

    it("cuts before truncating, so a marker at the limit keeps the record at 200 characters", () => {
      expect(recordedFor(`${"x".repeat(199)}=hunter2`)).toBe(`${"x".repeat(199)}=`);
    });

    it.each([
      ["an empty label", "", ""],
      ["a long label", "l".repeat(300), "l".repeat(200)],
    ])("records %s verbatim, truncated", (_name, label, expected) => {
      expect(recordedFor("SECRET=1 npm test", label)).toBe(expected);
    });
  });

  describe("re-entrancy", () => {
    it("admits a nested acquire naming a live holder at once, without touching process.env", () => {
      const ambient = process.env.CO_LEASE_HOLDER; // set when this suite itself runs under a lease
      const a = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      expect(a.childEnv()).toEqual({ CO_LEASE_HOLDER: a.id });
      expect(process.env.CO_LEASE_HOLDER).toBe(ambient);
      const nested = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 }, inheritedHolderId: a.id! }), meta)!;
      expect(nested).toMatchObject({ leased: true, id: a.id });
      nested.release();
      expect(existsSync(holderFile(a.id!))).toBe(true);
    });

    it("admits a nested acquire even at critical", () => {
      const a = tryAcquireLease(opts(), meta)!;
      level = "critical";
      expect(tryAcquireLease(opts({ inheritedHolderId: a.id! }), meta)?.leased).toBe(true);
    });

    it.each([["an unknown id", "1-nope"], ["undefined", undefined]])("does not bypass capacity for %s", (_n, inheritedHolderId) => {
      const o = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 }, inheritedHolderId });
      tryAcquireLease(o, meta)!;
      expect(tryAcquireLease(o, meta)).toBeNull();
    });

    it("does not honour the id of a holder that has been reaped", () => {
      plantHolder("4242-eeee", {});
      expect(tryAcquireLease(opts({ inheritedHolderId: "4242-eeee", policy: { heavyCeiling: 0, heavyWarning: 0 } }), meta)).toBeNull();
    });
  });

  describe("waiting", () => {
    const full = { policy: { heavyCeiling: 1, heavyWarning: 1 } };

    it("returns a max-wait refusal once maxWaitMs has elapsed, never sleeping past it", async () => {
      tryAcquireLease(opts(full), meta);
      const onWait = vi.fn();
      const r = await acquireLease(opts(full), meta, { maxWaitMs: 5_000, onWait });
      expect(r).toEqual({ refused: "max-wait", waitedMs: 5_000, level: "normal", live: 1 });
      expect(fake.sleeps.reduce((a, b) => a + b, 0)).toBe(5_000);
      expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ capacity: 1 }));
      expect(events).toContainEqual({ type: "timeout", refused: "max-wait", waitedMs: 5_000 });
    });

    it("stops on the first poll where stopWhen holds and a fresh read confirms it", async () => {
      level = "critical";
      const stopWhen = vi.fn((s) => s.level === "critical" && s.live.length === 0);
      const r = await acquireLease(opts(), meta, { stopWhen });
      expect(r).toEqual({ refused: "stopped", waitedMs: 0, level: "critical", live: 0 });
      expect(fake.sleeps).toEqual([]);
      expect(stopWhen).toHaveBeenCalledTimes(2);
    });

    it("lets a fresh reading delay a stop that a stale cached sample asked for", async () => {
      level = "critical";
      freshLevel = "normal";
      const stopWhen = vi.fn((s) => s.level === "critical");
      const r = await acquireLease(opts(), meta, { stopWhen, maxWaitMs: 4_000 });
      expect(r).toMatchObject({ refused: "max-wait" });
      expect(stopWhen).toHaveBeenCalledWith(expect.objectContaining({ level: "normal", capacity: 2 }));
    });

    it("evaluates stopWhen on a poll that hit an I/O error, with no live holders", async () => {
      level = "critical";
      const seen: number[] = [];
      const dir = unwritableLeaseDir(tmp);
      const r = await acquireLease(opts({ dir }), meta, {
        stopWhen: (s) => (seen.push(s.live.length), s.live.length === 0),
      });
      expect(r).toMatchObject({ refused: "stopped" });
      expect(seen).toEqual([0, 0]);
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe("FIFO tickets", () => {
    const TICKET_FRESH_MS = 15_000;
    const ticketFile = (id: string): string => join(dir, "waiting", `${id}.json`);
    const tickets = (): string[] => (existsSync(join(dir, "waiting")) ? readdirSync(join(dir, "waiting")).sort() : []);
    /** A ticket for a waiter in another process: `pid` is alive unless `dead`, and its last refresh was `ageMs` before the injected clock. */
    const plantTicket = (id: string, seq: number, { ageMs = 0, dead = false, ...extra }: { ageMs?: number; dead?: boolean; gated?: boolean; capacity?: number; ready?: boolean } = {}): void => {
      const pid = 5000 + seq;
      mkdirSync(join(dir, "waiting"), { recursive: true, mode: 0o700 });
      writeFileSync(ticketFile(id), JSON.stringify({ seq, id, pid, label: "other", gated: false, ...extra }));
      const at = (fake.ms - ageMs) / 1000;
      utimesSync(ticketFile(id), at, at);
      if (!dead) alive.add(pid);
    };
    /** Sleeps `yields` macrotasks before the fake sleep, so a waiter that started earlier polls later. Keep it small: the shared clock moves 3 s per sleep, and a waiter idle for 15 s of it goes stale. */
    const slowSleep = (yields: number): LeaseOptions["sleep"] => async (ms) => {
      for (let i = 0; i < yields; i++) await new Promise((r) => setImmediate(r));
      await fake.sleep(ms);
    };

    it.each<[string, number, { id: string; seq: number; ageMs?: number; dead?: boolean }[], boolean, string[]]>([
      ["no tickets and a free slot", 0, [], true, []],
      ["the one eligible ticket ahead, with two free slots", 0, [{ id: "a", seq: 1 }], true, ["a.json"]],
      ["two eligible tickets ahead, with two free slots", 0, [{ id: "a", seq: 1 }, { id: "b", seq: 2 }], false, ["a.json", "b.json"]],
      ["an eligible ticket ahead, with one free slot", 1, [{ id: "a", seq: 1 }], false, ["a.json"]],
      ["no tickets and no free slot", 2, [], false, []],
      ["a stale ticket (its waiter stopped), passed over and kept", 1, [{ id: "a", seq: 1, ageMs: TICKET_FRESH_MS + 1_000 }], true, ["a.json"]],
      ["a ticket from the future beyond the window, passed over and kept", 1, [{ id: "a", seq: 1, ageMs: -(TICKET_FRESH_MS + 1_000) }], true, ["a.json"]],
      ["a ticket just inside the window", 1, [{ id: "a", seq: 1, ageMs: TICKET_FRESH_MS - 1_000 }], false, ["a.json"]],
      ["a dead waiter's ticket, reaped", 1, [{ id: "a", seq: 1, dead: true }], true, []],
    ])("with %s", async (_name, holders, planted, admitted, left) => {
      for (let i = 0; i < holders; i++) plantHolder(`4242-live${i}`, {}, 0);
      alive.add(4242);
      for (const t of planted) plantTicket(t.id, t.seq, t);
      const r = await acquireLease(opts(), meta, { maxWaitMs: 0 });
      expect(isHandle(r)).toBe(admitted);
      if (isHandle(r)) r.release();
      expect(tickets()).toEqual(left);
    });

    it("assigns one more than the highest existing seq, stale or not, and refreshes the ticket on every poll", async () => {
      plantHolder("4242-live", {}, 0);
      alive.add(4242);
      plantTicket("a", 7, { ageMs: TICKET_FRESH_MS + 1_000 });
      const seen: { ticket: unknown; mtimeMs: number }[] = [];
      const one = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } });
      await acquireLease(one, meta, {
        maxWaitMs: 7_000,
        onWait: () => {
          const file = ticketFile(tickets().find((n) => n !== "a.json")!.slice(0, -".json".length));
          seen.push({ ticket: JSON.parse(readFileSync(file, "utf8")), mtimeMs: statSync(file).mtimeMs });
        },
      });
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[0].ticket).toMatchObject({ seq: 8, pid: process.pid, label: "npm test", gated: false });
      for (const s of seen) expect(s.ticket).toMatchObject({ seq: 8 });
      expect(seen[1].mtimeMs).toBeGreaterThan(seen[0].mtimeMs);
      expect(Math.abs(seen.at(-1)!.mtimeMs - (fake.ms - fake.sleeps.at(-1)!))).toBeLessThan(2);
      expect(tickets()).toEqual(["a.json"]);
    });

    it("admits three waiters in the order they arrived, even when the last to arrive polls first", async () => {
      const holder = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      fake.onSleep = () => holder.release();
      const order: string[] = [];
      const waiter = (name: string, yields: number): Promise<void> =>
        acquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 }, sleep: slowSleep(yields) }), meta).then((r) => {
          order.push(name);
          (r as LeaseHandle).release();
        });
      await Promise.all([waiter("A", 2), waiter("B", 1), waiter("C", 0)]);
      expect(order).toEqual(["A", "B", "C"]);
      expect(tickets()).toEqual([]);
    });

    it("admits the two oldest waiters in one cycle when two slots free up", async () => {
      const holders = [tryAcquireLease(opts(), meta)!, tryAcquireLease(opts(), meta)!];
      fake.onSleep = () => holders.splice(0).forEach((h) => h.release());
      const admitted: string[] = [];
      const waiter = (name: string, yields: number, maxWaitMs?: number): Promise<unknown> =>
        acquireLease(opts({ sleep: slowSleep(yields) }), meta, { maxWaitMs }).then((r) => {
          if (isHandle(r)) admitted.push(name);
          return r;
        });
      const [a, b, c] = await Promise.all([waiter("A", 2), waiter("B", 1), waiter("C", 0, 60_000)]);
      expect(admitted.sort()).toEqual(["A", "B"]);
      expect(c).toMatchObject({ refused: "max-wait" });
      (a as LeaseHandle).release();
      (b as LeaseHandle).release();
      expect(tickets()).toEqual([]);
    });

    it.each<[string, number, { capacity?: number; ready?: boolean }, number, boolean]>([
      ["an owner at critical (capacity 0) that can never be admitted", 0, { capacity: 0 }, 1, true],
      ["an owner with fewer slots, none left for it", 1, { capacity: 1 }, 2, true],
      ["an owner whose slot count could take the free slot", 1, { capacity: 2 }, 2, false],
      ["a ticket from a build that records no capacity", 1, {}, 2, false],
      ["a gated owner whose gates failed at its last poll", 1, { capacity: 2, ready: false }, 2, true],
      ["a gated owner whose gates passed at its last poll", 1, { capacity: 2, ready: true }, 2, false],
    ])("with a ticket ahead of %s", async (_name, holders, ticket, ceiling, admitted) => {
      for (let i = 0; i < holders; i++) plantHolder(`4242-live${i}`, {}, 0);
      alive.add(4242);
      plantTicket("a", 1, { gated: ticket.ready !== undefined, ...ticket });
      const r = await acquireLease(opts({ policy: { heavyCeiling: ceiling, heavyWarning: ceiling } }), meta, { maxWaitMs: 0 });
      expect(isHandle(r)).toBe(admitted);
    });

    it("returns the admission when removing the admitted ticket fails, and leaves no holder behind", async () => {
      const holder = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta)!;
      fake.onSleep = () => holder.release();
      const real = fs.rmSync;
      vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
        if (String(path).includes("/waiting/")) throw Object.assign(new Error("boom"), { code: "EIO" });
        return real(path, options);
      });
      syncBuiltinESMExports();
      try {
        const r = await acquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta);
        expect(r).toMatchObject({ leased: true });
        (r as LeaseHandle).release();
        expect(readdirSync(join(dir, "holders"))).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
      }
    });

    describe("leaves no ticket behind", () => {
      const full = { policy: { heavyCeiling: 1, heavyWarning: 1 } };
      it.each<[string, () => Promise<unknown>]>([
        ["a stop rule", () => (level = "critical", acquireLease(opts(), meta, { stopWhen: () => true }))],
        ["a busy mutex that fails open", () => (busyMutex(), acquireLease(opts(), meta))],
        [
          "an I/O error",
          () => {
            tryAcquireLease(opts(full), meta);
            fake.onSleep = () => (rmSync(join(dir, "holders"), { recursive: true }), symlinkSync(tmp, join(dir, "holders")));
            return acquireLease(opts(full), meta);
          },
        ],
        [
          "a throw from onWait",
          () => {
            tryAcquireLease(opts(full), meta);
            return acquireLease(opts(full), meta, { onWait: () => { throw new Error("progress line failed"); } }).catch(() => undefined);
          },
        ],
      ])("after %s", async (_name, run) => {
        await run();
        expect(tickets()).toEqual([]);
      });
    });

    it("refuses tryAcquireLease while an eligible ticket waits, and writes no ticket", () => {
      tryAcquireLease(opts(), meta)!.release();
      plantTicket("a", 1);
      expect(tryAcquireLease(opts(), meta)).toBeNull();
      expect(tickets()).toEqual(["a.json"]);
    });

    it("admits tryAcquireLease past a stale ticket", () => {
      tryAcquireLease(opts(), meta)!.release();
      plantTicket("a", 1, { ageMs: TICKET_FRESH_MS + 1_000 });
      expect(tryAcquireLease(opts(), meta)?.leased).toBe(true);
      expect(tickets()).toEqual(["a.json"]);
    });

    it("admits a nested acquire naming a live holder past waiting tickets, without queueing", async () => {
      const full = { policy: { heavyCeiling: 1, heavyWarning: 1 } };
      const a = tryAcquireLease(opts(full), meta)!;
      plantTicket("a", 1);
      const nested = await acquireLease(opts({ ...full, inheritedHolderId: a.id! }), meta, { maxWaitMs: 0 });
      expect(nested).toMatchObject({ leased: true, id: a.id });
      expect(tickets()).toEqual(["a.json"]);
    });

    it("admits a second acquire for a live detached id past waiting tickets, without queueing", async () => {
      const full = { policy: { heavyCeiling: 1, heavyWarning: 1 } };
      const detached = { command: "npm test", cwd: "/work", detached: { id: "hook-1", sessionPid: process.pid, expiresAt: fake.ms + 60_000 } };
      tryAcquireLease(opts(full), detached)!;
      plantTicket("a", 1);
      const again = await acquireLease(opts(full), detached, { maxWaitMs: 0 });
      expect(again).toMatchObject({ leased: true, id: "hook-1" });
      expect(tickets()).toEqual(["a.json"]);
    });

    describe("gated tickets", () => {
      const gated: HolderMeta = { ...meta, gated: true };
      const cpuFile = (): string => join(dir, "cpu.json");
      const markFile = (): string => join(dir, "lastAdmit");
      const waiting = (id: string): string => join(dir, "waiting", `${id}.json`);
      let ticks: { idle: number; total: number };
      let cpuTimes: LeaseOptions["cpuTimes"];
      const gatedOpts = (over: Partial<LeaseOptions> = {}): LeaseOptions => opts({ cpuTimes, ...over });
      const attemptGated = async (m: HolderMeta = gated, over: Partial<LeaseOptions> = {}): Promise<boolean> => {
        const r = await acquireLease(gatedOpts(over), m, { maxWaitMs: 0 });
        if (isHandle(r)) r.release();
        return isHandle(r);
      };
      /** A reading `ageMs` old whose tick counters make the machine `busy` busy since then; `stored` is the busy it records. */
      const plantCpu = (ageMs: number, busy: number, stored: number | null = busy): void => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const total = 1_000;
        writeFileSync(cpuFile(), JSON.stringify({ at: fake.ms - ageMs, ticks: { idle: ticks.idle - Math.round((1 - busy) * total), total: ticks.total - total }, busy: stored }));
      };
      const plantMark = (agoMs: number): void => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(markFile(), "");
        utimesSync(markFile(), (fake.ms - agoMs) / 1000, (fake.ms - agoMs) / 1000);
      };
      const suspendedHolder = (): void => {
        plantHolder("4242-live", { suspended: true }, 0);
        alive.add(4242);
      };

      beforeEach(() => {
        ticks = { idle: 10_000, total: 20_000 };
        cpuTimes = () => ticks;
        plantCpu(5_000, 0.1);
      });

      it.each<[string, () => void, boolean]>([
        ["CPU busy just under 0.75", () => plantCpu(5_000, 0.74), true],
        ["CPU busy at 0.75", () => plantCpu(5_000, 0.75), false],
        ["CPU busy at 0.95", () => plantCpu(5_000, 0.95), false],
        ["a reading 2 s old, which gets a delta, not its stored busy", () => plantCpu(2_000, 0.5, 0.9), true],
        ["a reading under 2 s old, gated on its stored busy (low)", () => plantCpu(1_999, 0.99, 0.1), true],
        ["a reading under 2 s old, gated on its stored busy (high)", () => plantCpu(1_999, 0.1, 0.9), false],
        ["a reading 10 s old, which still gets a delta", () => plantCpu(10_000, 0.5), true],
        ["a reading over 10 s old, which fails this poll", () => plantCpu(10_001, 0.1), false],
        ["a reading from the future, which fails this poll", () => plantCpu(-1_000, 0.1), false],
        ["no reading, which fails this poll", () => rmSync(cpuFile()), false],
        ["an unreadable reading, which fails this poll", () => writeFileSync(cpuFile(), "{"), false],
        ["a tick read that throws, which passes", () => (cpuTimes = () => { throw new Error("no cpus"); }), true],
        ["no tick reader, which passes", () => (cpuTimes = undefined), true],
        ["a live holder that is not suspended", () => (plantHolder("4242-live", {}, 0), alive.add(4242)), true],
        ["a live holder that is suspended", suspendedHolder, false],
        ["no earlier gated admission", () => rmSync(markFile(), { force: true }), true],
        ["a gated admission 19.999 s ago", () => plantMark(19_999), false],
        ["a gated admission 20 s ago", () => plantMark(20_000), true],
        ["a gated admission dated in the future", () => plantMark(-60_000), true],
      ])("with %s", async (_name, setUp, admitted) => {
        plantHolder("4242-live", {}, 0); // something runs, so the no-wedge rule stays out of it
        alive.add(4242);
        setUp();
        expect(await attemptGated()).toBe(admitted);
      });

      it.each<[string, () => void, boolean]>([
        ["a busy CPU and nothing live", () => plantCpu(5_000, 0.95), true],
        ["no CPU reading and nothing live", () => rmSync(cpuFile()), true],
        ["a recent gated admission and nothing live", () => plantMark(1_000), true],
        ["a busy CPU with a holder live", () => (plantCpu(5_000, 0.95), plantHolder("4242-live", {}, 0), alive.add(4242)), false],
        ["a recent admission with a suspended holder live", () => (plantMark(1_000), suspendedHolder()), false],
        ["an older gated ticket waiting, though nothing is live", () => (plantCpu(5_000, 0.95), plantTicket("old", 1, { gated: true, capacity: 2 })), false],
        ["an older ungated ticket waiting, though nothing is live", () => (plantCpu(5_000, 0.95), plantTicket("old", 1)), true],
      ])("applies the no-wedge rule with %s", async (_name, setUp, admitted) => {
        setUp();
        expect(await attemptGated()).toBe(admitted);
      });

      it("never applies the no-wedge rule at step 0", async () => {
        plantCpu(5_000, 0.95);
        const step0 = scriptedHeadroomSampler({ level: "critical", step: 0, signals: null });
        expect(await attemptGated(gated, { headroom: step0, policy: { heavyCeiling: 2, heavyWarning: 1 } })).toBe(false);
      });

      it("computes busy from the delta and rewrites cpu.json on the lease clock", async () => {
        plantCpu(5_000, 0.5);
        expect(await attemptGated()).toBe(true);
        expect(JSON.parse(readFileSync(cpuFile(), "utf8"))).toEqual({ at: fake.ms, ticks, busy: 0.5 });
      });

      it("stores its ticks and fails a cold poll, then admits the next on a real delta", async () => {
        rmSync(cpuFile());
        plantMark(60_000);
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        expect(await attemptGated()).toBe(false);
        expect(JSON.parse(readFileSync(cpuFile(), "utf8"))).toMatchObject({ at: fake.ms, ticks, busy: null });
        fake.ms += 3_000;
        ticks = { idle: ticks.idle + 900, total: ticks.total + 1_000 };
        expect(await attemptGated()).toBe(true);
      });

      it("marks the admission in lastAdmit on the lease clock, so the next gated start waits 20 s", async () => {
        const first = (await acquireLease(gatedOpts(), gated, { maxWaitMs: 0 })) as LeaseHandle;
        expect(first.leased).toBe(true);
        expect(Math.abs(statSync(markFile()).mtimeMs - fake.ms)).toBeLessThan(2);
        plantCpu(5_000, 0.1);
        expect(await attemptGated()).toBe(false);
        fake.ms += 20_000;
        plantCpu(5_000, 0.1);
        expect(await attemptGated()).toBe(true);
        first.release();
      });

      it("never gates an ungated waiter and writes neither record for it", async () => {
        rmSync(cpuFile());
        plantMark(1_000);
        suspendedHolder();
        const before = statSync(markFile()).mtimeMs;
        expect(await attemptGated(meta)).toBe(true);
        expect(existsSync(cpuFile())).toBe(false);
        expect(statSync(markFile()).mtimeMs).toBe(before);
      });

      it.each<[string, { ready?: boolean }, boolean]>([
        ["a gated ticket ahead that failed its gates", { ready: false }, true],
        ["a gated ticket ahead that passed its gates", { ready: true }, false],
      ])("admits an ungated waiter past %s only when it does not block", async (_name, ticket, admitted) => {
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        plantTicket("g", 1, { gated: true, capacity: 2, ...ticket });
        expect(await attemptGated(meta)).toBe(admitted);
      });

      it.each<[string, { ready?: boolean }]>([
        ["that failed its gates at its last poll", { ready: false }],
        ["that passed its gates at its last poll", { ready: true }],
      ])("keeps a gated waiter behind an older gated ticket %s, since the gates are machine-wide", async (_name, ticket) => {
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        plantTicket("g", 1, { gated: true, capacity: 2, ...ticket });
        expect(await attemptGated()).toBe(false);
      });

      const wide = { policy: { heavyCeiling: 4, heavyWarning: 1 } };
      it.each<[string, Record<string, unknown>, boolean]>([
        ["an older gated ticket that failed its gates, with 3 slots free", { capacity: 4, ready: false }, false],
        ["an older gated ticket that passed its gates, with 3 slots free", { capacity: 4, ready: true }, false],
        ["an older gated ticket whose own capacity leaves it no slot", { capacity: 1, ready: true }, true],
        ["a stale older gated ticket", { capacity: 4, ready: false, ageMs: TICKET_FRESH_MS + 1_000 }, true],
        ["an older gated ticket and nothing live", { capacity: 4, ready: true, nothingLive: true }, false],
      ])("with %s, a gated waiter is admitted only past tickets that cannot be", async (_name, { nothingLive, ...ticket }, admitted) => {
        if (!nothingLive) {
          plantHolder("4242-live", {}, 0);
          alive.add(4242);
        }
        plantTicket("g", 1, { gated: true, ...ticket });
        expect(await attemptGated(gated, wide)).toBe(admitted);
      });

      it("records a gated waiter held behind an older gated ticket as not ready, so ungated waiters pass it", async () => {
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        plantTicket("g", 1, { gated: true, capacity: 4, ready: true });
        let seen: unknown;
        await acquireLease(gatedOpts(wide), gated, {
          maxWaitMs: 1,
          onWait: () => (seen = JSON.parse(readFileSync(waiting(readdirSync(join(dir, "waiting")).find((n) => n !== "g.json")!.slice(0, -5)), "utf8"))),
        });
        expect(seen).toMatchObject({ gated: true, ready: false });
      });

      it("records the owner's capacity, gate state and gated flag on its ticket", async () => {
        plantCpu(5_000, 0.95);
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        let seen: unknown;
        await acquireLease(gatedOpts(), gated, {
          maxWaitMs: 1,
          onWait: () => (seen = JSON.parse(readFileSync(waiting(readdirSync(join(dir, "waiting"))[0].slice(0, -5)), "utf8"))),
        });
        expect(seen).toMatchObject({ gated: true, capacity: 2, ready: false, label: "npm test" });
      });

      it("reads the CPU on every poll, so a gated waiter that capacity holds back keeps a valid delta", async () => {
        plantHolder("4242-live", {}, 0);
        alive.add(4242);
        plantHolder("4242-live2", {}, 0);
        expect(await attemptGated()).toBe(false);
        expect(JSON.parse(readFileSync(cpuFile(), "utf8")).at).toBe(fake.ms);
      });
    });
  });

  describe("pressure override", () => {
    it.each([
      [true, "warning", true],
      [false, "warning", undefined],
      [undefined, "warning", undefined],
    ] as const)("sampler overridden()=%s at %s records override=%s in the holder file and the acquire event", (overridden, lvl, expected) => {
      level = lvl;
      const sampler = scriptedPressureSampler(() => level, { overridden });
      const h = tryAcquireLease(opts({ level: sampler }), meta)!;
      expect(readHolder(h).override).toBe(expected);
      expect(h.admission.override).toBe(expected);
      expect("override" in events.find((e) => e.type === "acquire")!).toBe(expected === true);
    });
  });

  describe("widened events", () => {
    it("records the held time on release, and no exitCode when none is given", () => {
      const h = tryAcquireLease(opts(), meta)!;
      const g = tryAcquireLease(opts(), meta)!;
      fake.ms += 12_345;
      h.release({ exitCode: 1 });
      g.release();
      expect(events.filter((e) => e.type === "release")).toStrictEqual([
        { type: "release", id: h.id, heldMs: 12_345, exitCode: 1 },
        { type: "release", id: g.id, heldMs: 12_345 },
      ]);
    });

    it("records the level of a stopped refusal, none for a max-wait one", async () => {
      level = "critical";
      await acquireLease(opts(), meta, { stopWhen: (s) => s.level === "critical" });
      await acquireLease(opts(), meta, { maxWaitMs: 0 });
      expect(events.filter((e) => e.type === "timeout")).toStrictEqual([
        { type: "timeout", refused: "stopped", waitedMs: 0, level: "critical" },
        { type: "timeout", refused: "max-wait", waitedMs: 0 },
      ]);
    });

    it("records the error code and message of an I/O fail-open, none for a busy mutex", async () => {
      tryAcquireLease(opts({ dir: unwritableLeaseDir(tmp) }), meta);
      busyMutex();
      fake.onSleep = () => utimesSync(join(dir, ".mutex"), fake.ms / 1000, fake.ms / 1000);
      await acquireLease(opts(), meta);
      expect(events.filter((e) => e.type === "fail-open")).toStrictEqual([
        { type: "fail-open", reason: "io-error", waitedMs: 0, code: "ENOTDIR", message: expect.any(String) },
        { type: "fail-open", reason: "mutex-busy", waitedMs: expect.any(Number) },
      ]);
    });
  });

  describe("a failing filesystem", () => {
    const failMutexOpen = (code: string) => {
      const real = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        if (String(path).endsWith(".mutex")) throw Object.assign(new Error(code), { code });
        return (real as (...a: unknown[]) => number)(path, ...rest);
      }) as typeof fs.openSync);
      syncBuiltinESMExports();
    };
    afterEach(() => {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    });

    it.each<[string, boolean]>([
      ["ENOSPC", true],
      ["EDQUOT", true],
      ["EACCES", false],
    ])("a %s error %s the lease refuses (otherwise it fails open)", async (code, refused) => {
      failMutexOpen(code);
      const got = await acquireLease(opts(), meta);
      expect(tryAcquireLease(opts(), meta)).toSatisfy((t: unknown) => (refused ? t === null : (t as LeaseHandle).leased === false));
      if (refused) {
        expect(got).toMatchObject({ refused: "disk-full", code });
        expect(events).toContainEqual({ type: "timeout", refused: "disk-full", waitedMs: 0 });
        expect(events.some((e) => e.type === "fail-open")).toBe(false);
      } else {
        expect(got).toMatchObject({ leased: false });
        expect(events.some((e) => e.type === "fail-open")).toBe(true);
      }
    });
  });

  describe("headroom", () => {
    const reading = (step: number, level: PressureLevel = "normal", signals: HeadroomReading["signals"] = null): HeadroomReading => ({ level, step, signals });
    const wide = { heavyCeiling: 6, heavyWarning: 1 };

    it.each([
      [4, 6],
      [3, 3],
      [2, 2],
      [1, 1],
      [0, 0],
    ])("admits %i-step capacity %i, then refuses the next", (step, capacity) => {
      const o = opts({ headroom: scriptedHeadroomSampler(reading(step)), policy: wide });
      expect(leaseStatus(o)).toMatchObject({ step, capacity });
      for (let i = 0; i < capacity; i++) expect(tryAcquireLease(o, meta)).not.toBeNull();
      expect(tryAcquireLease(o, meta)).toBeNull();
    });

    it("sizes capacity from the step, not the level, when both are given", () => {
      level = "critical";
      expect(tryAcquireLease(opts({ headroom: scriptedHeadroomSampler(reading(4)) }), meta)).not.toBeNull();
    });

    it("reports the step and signals beside the unchanged level, capacity and live", () => {
      const signals = { level: "warning" as const, freePct: 35 };
      expect(leaseStatus(opts({ headroom: scriptedHeadroomSampler(reading(2, "warning", signals)), policy: wide }))).toEqual({
        level: "warning",
        capacity: 2,
        step: 2,
        signals,
        live: [],
      });
    });

    it.each<[PressureLevel, number, number]>([
      ["normal", 4, 2],
      ["warning", 1, 1],
      ["critical", 0, 0],
    ])("derives the step from a lone %s level as %i, with no signals", (lv, step, capacity) => {
      level = lv;
      expect(leaseStatus(opts())).toEqual({ level: lv, capacity, step, signals: null, live: [] });
    });

    it("records the step on the acquire event, from either source", () => {
      tryAcquireLease(opts({ headroom: scriptedHeadroomSampler(reading(3)), policy: wide }), meta)!.release();
      level = "warning";
      tryAcquireLease(opts(), meta)!.release();
      expect(events.filter((e) => e.type === "acquire").map((e) => (e as { step: number }).step)).toEqual([3, 1]);
    });

    it("marks an admission overridden from the headroom sampler's flag", () => {
      const h = tryAcquireLease(opts({ headroom: scriptedHeadroomSampler(reading(1), { overridden: true }) }), meta)!;
      expect(h.admission.override).toBe(true);
    });

    it("confirms a stop through headroom.fresh(), so a stale shared step delays it", async () => {
      const stale = scriptedHeadroomSampler(reading(0, "critical"), { fresh: () => reading(4) });
      const stopWhen = vi.fn((s) => s.step === 0);
      const r = await acquireLease(opts({ headroom: stale }), meta, { stopWhen, maxWaitMs: 4_000 });
      expect(r).toMatchObject({ refused: "max-wait" });
      expect(stopWhen).toHaveBeenCalledWith(expect.objectContaining({ level: "normal", step: 4, capacity: 2 }));
    });

    it("refuses a stop that headroom.fresh() confirms", async () => {
      const r = await acquireLease(opts({ headroom: scriptedHeadroomSampler(reading(0, "critical")) }), meta, { stopWhen: (s) => s.level === "critical" });
      expect(r).toEqual({ refused: "stopped", waitedMs: 0, level: "critical", live: 0 });
    });

    describe("from defaultLeaseOptions", () => {
      const share = (record: Record<string, unknown>) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "headroom.json"), JSON.stringify({ at: Date.now(), risingSince: null, ...record }));
      };

      it("gives two option sets on one directory the same step, level view and capacity", () => {
        share({ signals: { level: "warning", freePct: 35 }, step: 2 });
        const a = defaultLeaseOptions({ CO_LEASE_DIR: dir });
        const b = defaultLeaseOptions({ CO_LEASE_DIR: dir });
        const expected = { level: "warning", step: 2, capacity: 2, signals: { level: "warning", freePct: 35 } };
        expect(leaseStatus(a)).toMatchObject(expected);
        expect(leaseStatus(b)).toMatchObject(expected);
        expect(a.level()).toBe("warning");
      });

      it("reads step 0 as 1 in the overriding process only, and never writes the 1", () => {
        share({ signals: { level: "critical", freePct: 3 }, step: 0 });
        const before = readFileSync(join(dir, "headroom.json"), "utf8");
        expect(leaseStatus(defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_PRESSURE_OVERRIDE: "critical-as-warning" }))).toMatchObject({ level: "warning", step: 1, capacity: 1 });
        expect(leaseStatus(defaultLeaseOptions({ CO_LEASE_DIR: dir }))).toMatchObject({ level: "critical", step: 0, capacity: 0 });
        expect(readFileSync(join(dir, "headroom.json"), "utf8")).toBe(before);
      });
    });
  });

  it("exports the public API from the barrel", () => {
    expect(barrel.acquireLease).toBe(acquireLease);
    expect(barrel.tryAcquireLease).toBe(tryAcquireLease);
    expect(barrel.leaseStatus).toBe(leaseStatus);
    expect(barrel.defaultLeaseOptions).toBe(defaultLeaseOptions);
    expect(barrel.releaseHolder).toBe(releaseHolder);
  });
});
