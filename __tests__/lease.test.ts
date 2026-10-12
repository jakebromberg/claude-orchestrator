import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLease,
  defaultLeaseOptions,
  leaseStatus,
  tryAcquireLease,
  type HolderMeta,
  type LeaseEvent,
  type LeaseHandle,
  type LeaseOptions,
  type LeaseRefusal,
} from "../src/lease.js";
import * as barrel from "../src/index.js";
import type { PressureLevel } from "../src/memory-pressure.js";

const meta: HolderMeta = { command: "npm test", cwd: "/work" };
const isHandle = (r: LeaseHandle | LeaseRefusal): r is LeaseHandle => "leased" in r;

describe("lease", () => {
  let tmp: string;
  let dir: string;
  let clock: number;
  let level: PressureLevel;
  let freshLevel: PressureLevel | undefined;
  let alive: Set<number>;
  let events: LeaseEvent[];
  let warnings: string[];
  let sleeps: number[];
  let onSleep: () => void;

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => ({
    dir,
    level: Object.assign(() => level, { fresh: () => freshLevel ?? level }),
    policy: { heavyCeiling: 2, heavyWarning: 1 },
    isAlive: (pid) => alive.has(pid),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      onSleep();
    },
    onEvent: (e) => events.push(e),
    warn: (m) => warnings.push(m),
    ...over,
  });
  const holderFile = (id: string): string => join(dir, "holders", `${id}.json`);
  const readHolder = (h: LeaseHandle) => JSON.parse(readFileSync(holderFile(h.id!), "utf8"));
  /** Writes a holder file for wrapper PID 4242 (alive only if the test adds it to `alive`). */
  const writeHolder = (id: string, rec: Record<string, unknown>): void =>
    writeFileSync(holderFile(id), JSON.stringify({ id, pid: 4242, command: "x", cwd: "/", startedAt: clock, level: "normal", ...rec }));
  /** Creates the lease directory through an acquire (which reaps what it finds), then writes the holder. */
  const plantHolder = (id: string, rec: Record<string, unknown>): void => {
    tryAcquireLease(opts({ policy: { heavyCeiling: 99, heavyWarning: 99 } }), meta)!.release();
    writeHolder(id, rec);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-"));
    dir = join(tmp, "lease");
    clock = Date.now();
    level = "normal";
    freshLevel = undefined;
    alive = new Set([process.pid]);
    events = [];
    warnings = [];
    sleeps = [];
    onSleep = () => {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
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
      expect(events.filter((e) => e.type === "release")).toEqual([{ type: "release", id: a.id, exitCode: 0 }]);
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
      onSleep = () => a.release();
      const r = await acquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta);
      expect(isHandle(r) && r.leased).toBe(true);
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
      expect(sleeps[0]).toBeLessThanOrEqual(4_000);
      expect((r as LeaseHandle).admission.waitedMs).toBe(sleeps[0]);
    });

    it("records the wait, level, live count (including itself) and capacity at admission", () => {
      tryAcquireLease(opts(), meta);
      const b = tryAcquireLease(opts(), meta)!;
      expect(b.admission).toEqual({ waitedMs: 0, level: "normal", live: 2, capacity: 2 });
      expect(events.find((e) => e.type === "acquire" && e.id === b.id)).toMatchObject({ live: 2, capacity: 2 });
    });

    it("records the holder and reports it through leaseStatus", () => {
      const h = tryAcquireLease(opts(), { command: "npm test", cwd: "/work" })!;
      expect(readHolder(h)).toEqual({ id: h.id, pid: process.pid, command: "npm test", cwd: "/work", startedAt: clock, level: "normal" });
      h.setChildPid(777);
      expect(readHolder(h).childPid).toBe(777);
      const status = leaseStatus(opts());
      expect(status).toMatchObject({ level: "normal", capacity: 2 });
      expect(status.live).toMatchObject([{ id: h.id, pid: process.pid, command: "npm test", ageSec: 0 }]);
      h.release();
      expect(leaseStatus(opts()).live).toEqual([]);
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
      plantHolder("4242-ab01", { childPid: 900, startedAt: clock - 3 * 3_600_000 }); // orphan-bound: warns
      writeHolder("4242-ab02", {}); // dead
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
      plantHolder("4242-ab03", { childPid: 900, startedAt: clock - 3 * 3_600_000 }); // orphan-bound: warns and reaps
      const one = opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } });
      const mutexHeld: boolean[] = [];
      let second: LeaseHandle | null | undefined;
      const slow = (): void => {
        mutexHeld.push(existsSync(join(dir, ".mutex")));
        clock += 11_000; // outlives the mutex's 10 s staleness window
        if (second === undefined) second = tryAcquireLease(one, meta);
      };
      const first = tryAcquireLease({ ...one, onEvent: slow, warn: slow }, meta);
      expect({ first: first?.leased, second, mutexHeld }).toEqual({ first: true, second: null, mutexHeld: [false, false, false] });
      expect(leaseStatus(opts()).live).toHaveLength(1);
    });

    it("measures capped waiters starving behind uncapped ones (admission is not FIFO)", () => {
      const held = [tryAcquireLease(opts(), meta)!, tryAcquireLease(opts(), meta)!];
      const cappedLevel = { level: Object.assign(() => "warning" as const, { fresh: () => "warning" as const }) };
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
    // [description, wrapper alive?, child alive?, started ms ago, still live?]
    it.each([
      ["a live wrapper with no child", true, undefined, 10_000, true],
      ["a live wrapper whose child is dead", true, false, 60_000, true],
      ["a dead wrapper with a live child (killed wrapper keeps its slot)", false, true, 60_000, true],
      ["a dead wrapper with a dead child", false, false, 60_000, false],
      ["a dead wrapper with no child", false, undefined, 60_000, false],
      ["a live wrapper with a live child past the 2 h bound", true, true, 3 * 3_600_000, true],
      ["an orphaned live child past the 2 h bound", false, true, 3 * 3_600_000, false],
      ["an orphaned live child dated 1 h in the future (a clock step)", false, true, -3_600_000, true],
      ["an orphaned live child dated past the 2 h bound in the future", false, true, -3 * 3_600_000, false],
    ])("%s", (_name, wrapperAlive, childAlive, startedAgo, stillLive) => {
      if (wrapperAlive) alive.add(4242);
      if (childAlive) alive.add(900);
      plantHolder("4242-aaaa", { childPid: childAlive === undefined ? undefined : 900, startedAt: clock - startedAgo });
      const h = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), meta);
      expect(h === null).toBe(stillLive);
      expect(existsSync(holderFile("4242-aaaa"))).toBe(stillLive);
      expect(leaseStatus(opts()).live.some((x) => x.id === "4242-aaaa")).toBe(stillLive);
    });

    it("reaps an orphan past the bound with a warning and an event", () => {
      alive.add(900);
      plantHolder("4242-bbbb", { childPid: 900, startedAt: clock - 3 * 3_600_000 });
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

  describe("mutex and fail-open", () => {
    const busyMutex = (): void => {
      tryAcquireLease(opts(), meta)!.release();
      writeFileSync(join(dir, ".mutex"), "");
      utimesSync(join(dir, ".mutex"), clock / 1000, clock / 1000); // fresh on the injected clock, not from its future
    };

    it("treats a busy mutex as not admitted, without throwing", () => {
      busyMutex();
      expect(tryAcquireLease(opts(), meta)).toBeNull();
    });

    it("fails open after 30 s of a busy mutex, with one warning", async () => {
      busyMutex();
      // Keep the mutex fresh on the injected clock so it never reads as stale.
      onSleep = () => utimesSync(join(dir, ".mutex"), clock / 1000, clock / 1000);
      const r = await acquireLease(opts(), meta);
      expect(r).toMatchObject({ leased: false, id: null });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
      expect(warnings).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "fail-open", reason: "mutex-busy" }));
    });

    it("never fails open at critical: a busy mutex stays no free slot until maxWaitMs", async () => {
      busyMutex();
      level = "critical";
      onSleep = () => utimesSync(join(dir, ".mutex"), clock / 1000, clock / 1000);
      const r = await acquireLease(opts(), meta, { maxWaitMs: 60_000 });
      expect(r).toMatchObject({ refused: "max-wait", level: "critical" });
      expect(warnings).toEqual([]);
    });

    it("reaps a stale mutex left by a killed holder", () => {
      busyMutex();
      const old = (clock - 20_000) / 1000;
      utimesSync(join(dir, ".mutex"), old, old);
      expect(tryAcquireLease(opts(), meta)?.leased).toBe(true);
    });

    it("fails open on an unwritable directory, but counts it as no free slot at critical", () => {
      writeFileSync(join(tmp, "blocker"), "");
      const unwritable = { dir: join(tmp, "blocker", "lease") };
      const h = tryAcquireLease(opts(unwritable), meta)!;
      expect(h).toMatchObject({ leased: false, id: null });
      expect(h.childEnv()).toEqual({});
      expect(warnings).toHaveLength(1);
      level = "critical";
      expect(tryAcquireLease(opts(unwritable), meta)).toBeNull();
    });

    it("acquireLease fails open at once on an unwritable directory below critical", async () => {
      writeFileSync(join(tmp, "blocker"), "");
      expect(await acquireLease(opts({ dir: join(tmp, "blocker", "lease") }), meta)).toMatchObject({ leased: false });
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
      leaseStatus({ ...o, level: Object.assign(() => "normal" as const, { fresh: () => "normal" as const }) });
      expect(existsSync(lease)).toBe(false);
    });

    it("wires the environment into defaultLeaseOptions", () => {
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir, CO_LEASE_SLOTS: "3", CO_LEASE_HOLDER: "1-ab", CO_PRESSURE_OVERRIDE: "critical-as-warning" });
      expect(o).toMatchObject({ dir, policy: { heavyCeiling: 3 }, inheritedHolderId: "1-ab", override: true });
      expect(defaultLeaseOptions({ CO_LEASE_DIR: dir })).toMatchObject({ inheritedHolderId: undefined, override: false });
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
      [`bash -lc "cd db && PGPASSWORD=\"hunter2 x\" psql"`, `bash -lc "cd db && PGPASSWORD=…`],
      [`"$X"=hunter2 npm test`, `"$X"=…`],
      ["X[0]=hunter2 npm test", "X[0]=…"],
      ["TOKEN\\=hunter2 npm test", "TOKEN\\=…"],
      ["npm ci\nTOKEN=hunter2 npm test", "npm ci\nTOKEN=…"],
      ["git clone https://u:hunter2@h/r", "git clone https://…"],
      ["psql postgres://u:hunter2@h/db", "psql postgres://…"],
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
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5_000);
      expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ capacity: 1 }));
      expect(events).toContainEqual({ type: "timeout", refused: "max-wait", waitedMs: 5_000 });
    });

    it("stops on the first poll where stopWhen holds and a fresh read confirms it", async () => {
      level = "critical";
      const stopWhen = vi.fn((s) => s.level === "critical" && s.live.length === 0);
      const r = await acquireLease(opts(), meta, { stopWhen });
      expect(r).toEqual({ refused: "stopped", waitedMs: 0, level: "critical", live: 0 });
      expect(sleeps).toEqual([]);
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
      writeFileSync(join(tmp, "blocker"), "");
      level = "critical";
      const seen: number[] = [];
      const r = await acquireLease(opts({ dir: join(tmp, "blocker", "lease") }), meta, {
        stopWhen: (s) => (seen.push(s.live.length), s.live.length === 0),
      });
      expect(r).toMatchObject({ refused: "stopped" });
      expect(seen).toEqual([0, 0]);
    });
  });

  describe("pressure override", () => {
    it.each([
      [true, "warning", true],
      [true, "normal", undefined],
      [false, "warning", undefined],
    ] as const)("override=%s at %s records override=%s", (override, lvl, expected) => {
      level = lvl;
      const h = tryAcquireLease(opts({ override }), meta)!;
      expect(readHolder(h).override).toBe(expected);
    });
  });

  it("exports the public API from the barrel", () => {
    expect(barrel.acquireLease).toBe(acquireLease);
    expect(barrel.tryAcquireLease).toBe(tryAcquireLease);
    expect(barrel.leaseStatus).toBe(leaseStatus);
    expect(barrel.defaultLeaseOptions).toBe(defaultLeaseOptions);
  });
});
