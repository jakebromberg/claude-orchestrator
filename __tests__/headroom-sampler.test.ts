import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHeadroomSampler, levelView } from "../src/headroom-sampler.js";
import { DEFAULT_STEP_TABLE, MAX_STEP, type StepTable } from "../src/headroom.js";
import type { MemorySignals } from "../src/memory-pressure.js";
import { scriptedHeadroomSampler } from "../src/testing.js";

const HOLD: StepTable = { warning: [{ minFreePct: 0, step: 1 }], riseHoldMs: 60_000 };
/** One warning band and no rise hold: these suites test the sampler, not the default table. */
const FLAT: StepTable = { warning: [{ minFreePct: 0, step: 1 }], riseHoldMs: 0 };
const OVERRIDE = { CO_PRESSURE_OVERRIDE: "critical-as-warning" };

describe("defaultHeadroomSampler", () => {
  let dir: string;
  let t: number;
  let signals: MemorySignals | null;
  let reads: number;
  let log: ReturnType<typeof vi.fn>;

  const make = (extra: NodeJS.ProcessEnv = {}, table: StepTable = FLAT, over: { dir?: string } = {}) => {
    const read = () => (reads++, signals);
    return defaultHeadroomSampler({ CO_LEASE_DIR: over.dir ?? dir, ...extra }, { read, now: () => t, log, table });
  };
  const file = (name = "headroom.json") => join(dir, name);
  const stored = () => JSON.parse(readFileSync(file(), "utf8"));
  const plant = (record: unknown, name = "headroom.json") => writeFileSync(file(name), JSON.stringify(record));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headroom-"));
    t = 1_000_000;
    signals = { level: "normal", freePct: 50 };
    reads = 0;
    log = vi.fn();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the default table when none is passed: warning at 35% free is step 2", () => {
    signals = { level: "warning", freePct: 35 };
    expect(defaultHeadroomSampler({ CO_LEASE_DIR: dir }, { read: () => signals, now: () => t, log })().step).toBe(2);
  });

  it.each([
    ["inside a full climb, still holds the stored step", DEFAULT_STEP_TABLE.riseHoldMs * MAX_STEP - 1, 0],
    ["as old as a full climb, starts at the target", DEFAULT_STEP_TABLE.riseHoldMs * MAX_STEP, 4],
    ["hours old, starts at the target", 8 * 3_600_000, 4],
  ])("a stored step %s", (_n, gap, want) => {
    signals = { level: "critical", freePct: 3 };
    expect(make({}, DEFAULT_STEP_TABLE)().step).toBe(0);
    t += gap;
    signals = { level: "normal", freePct: 70 };
    expect(make({}, DEFAULT_STEP_TABLE)().step).toBe(want);
  });

  it.each([
    ["inside a full climb, still holds the in-process step", DEFAULT_STEP_TABLE.riseHoldMs * MAX_STEP - 1, 0],
    ["as old as a full climb, starts at the target", DEFAULT_STEP_TABLE.riseHoldMs * MAX_STEP, 4],
  ])("with no file to share, an in-process step %s", (_n, gap, want) => {
    const s = make({}, DEFAULT_STEP_TABLE, { dir: join(dir, "absent") });
    signals = { level: "critical", freePct: 3 };
    expect(s().step).toBe(0);
    t += gap;
    signals = { level: "normal", freePct: 70 };
    expect(s().step).toBe(want);
  });

  it("samples, returns the level, step and signals, and writes headroom.json beside level.json", () => {
    signals = { level: "warning", freePct: 35, swapUsedBytes: 5 };
    expect(make()()).toEqual({ level: "warning", step: 1, signals });
    expect(stored()).toEqual({ at: t, signals, step: 1, risingSince: null });
    expect(JSON.parse(readFileSync(file("level.json"), "utf8"))).toEqual({ level: "warning", at: t });
    expect(readdirSync(dir).sort()).toEqual(["headroom.json", "level.json"]);
  });

  it("serves a second sampler on the same directory from the file, so both agree without a second read", () => {
    signals = { level: "critical", freePct: 3 };
    const a = make();
    const b = make();
    expect(a().step).toBe(0);
    signals = { level: "normal", freePct: 60 };
    t += 9_999;
    expect(b()).toEqual({ level: "critical", step: 0, signals: { level: "critical", freePct: 3 } });
    expect(reads).toBe(1);
  });

  it("caches a reading in process for 10 s when there is no file to share", () => {
    const missing = join(dir, "absent");
    const s = make({}, undefined, { dir: missing });
    s();
    t += 9_999;
    s();
    expect(reads).toBe(1);
    t += 1;
    s();
    expect(reads).toBe(2);
  });

  it("recomputes from a file that is 10 s old", () => {
    const a = make();
    a();
    signals = { level: "warning", freePct: 20 };
    t += 10_000;
    expect(make()().step).toBe(1);
    expect(stored().at).toBe(t);
  });

  it("does not trust an `at` from the future", () => {
    plant({ at: t + 5_000, signals: { level: "critical", freePct: 1 }, step: 0, risingSince: null });
    expect(make()()).toMatchObject({ level: "normal", step: 4 });
    expect(stored().at).toBe(t);
  });

  it("restarts the hold when the stored risingSince is from the future", () => {
    plant({ at: t - 20_000, signals: { level: "normal", freePct: 50 }, step: 2, risingSince: t + 5_000 });
    expect(make({}, HOLD)().step).toBe(2);
    expect(stored()).toMatchObject({ step: 2, risingSince: t });
  });

  it("starts from the stored step and rises one step after the hold", () => {
    plant({ at: t - 20_000, signals: { level: "normal", freePct: 50 }, step: 1, risingSince: t - 60_000 });
    expect(make({}, HOLD)().step).toBe(2);
    expect(stored()).toMatchObject({ step: 2, risingSince: t });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a step of 7", { step: 7, risingSince: null }],
    ["a step of -1", { step: -1, risingSince: null }],
    ["a string step", { step: "3", risingSince: null }],
    ["a fractional step", { step: 2.5, risingSince: null }],
    ["a null step", { step: null, risingSince: null }],
    ["a string risingSince", { step: 2, risingSince: "5" }],
    ["a missing risingSince", { step: 2 }],
    ["signals without a level", { step: 2, risingSince: null, signals: {} }],
    ["null signals", { step: 2, risingSince: null, signals: null }],
  ])("treats a fresh file with %s as absent and samples", (_name, record) => {
    plant({ at: t, signals: { level: "warning", freePct: 35 }, ...record });
    expect(make()()).toMatchObject({ level: "normal", step: 4 });
    expect(reads).toBe(1);
  });

  it("starts at the target from a stale file with a malformed step, not from that step", () => {
    plant({ at: t - 20_000, signals: { level: "normal" }, step: -1, risingSince: t - 600_000 });
    expect(make({}, HOLD)().step).toBe(4);
  });

  it("starts at the target from a file that is not JSON", () => {
    writeFileSync(file(), "{ nope");
    expect(make({}, HOLD)().step).toBe(4);
  });

  it("applies the override to this process only: critical reads as warning, step 0 as 1, and the file keeps the machine step", () => {
    signals = { level: "critical", freePct: 3 };
    const mine = make(OVERRIDE);
    expect(mine()).toEqual({ level: "warning", step: 1, signals });
    expect(mine.overridden?.()).toBe(true);
    expect(stored()).toEqual({ at: t, signals, step: 0, risingSince: null });
    expect(JSON.parse(readFileSync(file("level.json"), "utf8")).level).toBe("critical");
    expect(make()()).toMatchObject({ level: "critical", step: 0 });
  });

  it("does not mark a reading overridden when nothing was mapped", () => {
    const s = make(OVERRIDE);
    s();
    expect(s.overridden?.()).toBe(false);
  });

  it("fresh() bypasses a fresh file and rewrites it", () => {
    const s = make();
    s();
    signals = { level: "warning", freePct: 20 };
    t += 1_000;
    expect(s()).toMatchObject({ step: 4 });
    expect(s.fresh()).toMatchObject({ level: "warning", step: 1 });
    expect(stored()).toMatchObject({ at: t, step: 1 });
    expect(make()()).toMatchObject({ step: 1 });
  });

  describe("a failed guarded read", () => {
    it("serves the last good reading under 60 s old, with no signals, and writes nothing new", () => {
      const s = make();
      s();
      signals = null;
      t += 59_999;
      expect(s.fresh()).toEqual({ level: "normal", step: 4, signals: null });
      expect(stored().at).toBe(t - 59_999);
      expect(log).toHaveBeenCalledWith("read failed; using the last good reading, else critical");
    });

    it("reads critical, step 0, once the last good reading is 60 s old", () => {
      const s = make();
      s();
      signals = null;
      t += 60_000;
      expect(s.fresh()).toEqual({ level: "critical", step: 0, signals: null });
    });

    it("falls back to level.json from another process, then to critical", () => {
      signals = null;
      plant({ level: "warning", at: t - 1_000 }, "level.json");
      expect(make()()).toMatchObject({ level: "warning", signals: null });
      plant({ level: "warning", at: t - 61_000 }, "level.json");
      expect(make().fresh()).toMatchObject({ level: "critical", step: 0 });
    });

    it("never reads unknown on a failed read", () => {
      signals = null;
      expect(make()().level).toBe("critical");
    });
  });

  describe("the lease directory", () => {
    it("creates nothing when the directory is missing, and still serves", () => {
      const missing = join(dir, "absent");
      expect(make({}, undefined, { dir: missing })().step).toBe(4);
      expect(existsSync(missing)).toBe(false);
    });

    it("writes nothing through a symlinked lease directory", () => {
      const real = mkdtempSync(join(tmpdir(), "headroom-real-"));
      const link = join(dir, "link");
      symlinkSync(real, link);
      try {
        expect(make({}, undefined, { dir: link })().step).toBe(4);
        expect(readdirSync(real)).toEqual([]);
      } finally {
        rmSync(real, { recursive: true, force: true });
      }
    });

    it("leaves no temp file behind, and two samplers never share one", () => {
      make().fresh();
      make().fresh();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("writes nothing on a platform with no signal (level unknown)", () => {
      signals = { level: "unknown" };
      expect(make()()).toEqual({ level: "unknown", step: 4, signals });
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("tells the injected log about an invalid override once", () => {
    const s = make({ CO_PRESSURE_OVERRIDE: "nope" });
    s();
    s.fresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("CO_PRESSURE_OVERRIDE"));
  });

  describe("levelView", () => {
    it("is a PressureSampler over the headroom sampler, sharing its override flag", () => {
      signals = { level: "critical", freePct: 3 };
      const view = levelView(make(OVERRIDE));
      expect(view()).toBe("warning");
      expect(view.overridden?.()).toBe(true);
      signals = { level: "normal", freePct: 50 };
      t += 1;
      expect(view.fresh()).toBe("normal");
      expect(view.overridden?.()).toBe(false);
    });
  });
});

describe("scriptedHeadroomSampler", () => {
  const r = (step: number) => ({ level: "normal" as const, step, signals: null });

  it("reads one reading per call, then holds the last, like scriptedPressureSampler", () => {
    const s = scriptedHeadroomSampler([r(4), r(2)]);
    expect([s().step, s().step, s().step]).toEqual([4, 2, 2]);
  });

  it("shares the script with fresh() unless told to disagree", () => {
    const stale = scriptedHeadroomSampler(r(0), { fresh: () => r(4) });
    expect([stale().step, stale.fresh().step]).toEqual([0, 4]);
  });

  it("has overridden() only when asked for", () => {
    expect("overridden" in scriptedHeadroomSampler(r(1))).toBe(false);
    expect(scriptedHeadroomSampler(r(1), { overridden: true }).overridden?.()).toBe(true);
  });

  it("rejects an empty list", () => {
    expect(() => scriptedHeadroomSampler([])).toThrow(/at least one/);
  });
});
