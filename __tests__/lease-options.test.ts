import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemorySignals } from "../src/memory-pressure.js";

const built = vi.hoisted(() => ({ deps: [] as ({ log?: (msg: string) => void; heavy?: (step: number, s: MemorySignals) => { live: number; weights?: { used: number; budget: number } } } | undefined)[] }));
vi.mock("../src/headroom-sampler.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/headroom-sampler.js")>();
  return {
    ...real,
    defaultHeadroomSampler: (env: NodeJS.ProcessEnv, deps?: { log?: (msg: string) => void; heavy?: (step: number, s: MemorySignals) => { live: number; weights?: { used: number; budget: number } } }) => {
      built.deps.push(deps);
      return real.defaultHeadroomSampler(env, deps);
    },
  };
});

const { scriptedPressureSampler } = await import("../src/testing.js");
const { defaultLeaseOptions, tryAcquireLease } = await import("../src/lease.js");

describe("defaultLeaseOptions sampler wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-options-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands the sampler it builds a log that reaches the caller's warn", () => {
    const warn = vi.fn();
    defaultLeaseOptions({ CO_LEASE_DIR: dir }, { warn });
    built.deps.at(-1)?.log?.("x");
    expect(warn).toHaveBeenCalledWith("memory-pressure: x");
  });

  it("builds no sampler when the caller supplies one", () => {
    built.deps.length = 0;
    const level = scriptedPressureSampler("normal", { overridden: false });
    const o = defaultLeaseOptions({ CO_LEASE_DIR: dir }, { level });
    expect(o.level).toBe(level);
    expect(o.headroom).toBeUndefined();
    expect(built.deps).toEqual([]);
  });

  it("derives level and level.fresh as views over the one headroom sampler it builds", () => {
    built.deps.length = 0;
    const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
    expect(built.deps).toHaveLength(1);
    expect(o.headroom).toBeDefined();
    expect(typeof o.level.fresh).toBe("function");
    expect(typeof o.level.overridden).toBe("function");
  });

  it("hands the sampler one scan of the live heavy holders under this lease directory: their count, and used and budget (free memory less the reserve, the step's share without a free reading, nothing without the machine's memory)", () => {
    const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
    const heavy = built.deps.at(-1)!.heavy!;
    const gib = 2 ** 30;
    const signals: MemorySignals = { level: "normal", freePct: 50, memsizeBytes: 16 * gib };
    const noFree: MemorySignals = { level: "normal", memsizeBytes: 16 * gib };
    expect(heavy(3, signals)).toEqual({ live: 0, weights: { used: 0, budget: 4 * gib } });
    expect(heavy(3, noFree)).toEqual({ live: 0, weights: { used: 0, budget: 9 * gib } });
    const handle = tryAcquireLease({ ...o, level: scriptedPressureSampler("normal"), headroom: undefined }, { command: "npm test", cwd: "/w", weight: 2 * gib });
    try {
      // The holder is younger than the ramp window, so the budget does not add its weight back.
      expect(heavy(3, signals)).toEqual({ live: 1, weights: { used: 2 * gib, budget: 4 * gib } });
      expect(heavy(3, noFree)).toEqual({ live: 1, weights: { used: 2 * gib, budget: 9 * gib } });
      expect(heavy(3, { level: "normal", freePct: 50 })).toEqual({ live: 1, weights: undefined });
    } finally {
      if (handle && "release" in handle) handle.release();
    }
  });
});
