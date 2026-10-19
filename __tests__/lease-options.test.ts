import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemorySignals } from "../src/memory-pressure.js";

const built = vi.hoisted(() => ({ deps: [] as ({ log?: (msg: string) => void; heavyLive?: () => number; heavyWeights?: (step: number, s: MemorySignals) => { used: number; budget: number } | undefined } | undefined)[] }));
vi.mock("../src/headroom-sampler.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/headroom-sampler.js")>();
  return {
    ...real,
    defaultHeadroomSampler: (env: NodeJS.ProcessEnv, deps?: { log?: (msg: string) => void; heavyLive?: () => number; heavyWeights?: (step: number, s: MemorySignals) => { used: number; budget: number } | undefined }) => {
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

  it("hands the sampler a count of the live heavy holders under this lease directory", () => {
    const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
    const heavyLive = built.deps.at(-1)!.heavyLive!;
    expect(heavyLive()).toBe(0);
    const handle = tryAcquireLease({ ...o, level: scriptedPressureSampler("normal"), headroom: undefined }, { command: "npm test", cwd: "/w" });
    try {
      expect(heavyLive()).toBe(1);
    } finally {
      if (handle && "release" in handle) handle.release();
    }
  });

  it("hands the sampler a weigher over the live heavy holders: used and budget at the step, nothing without the machine's memory", () => {
    const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
    const heavyWeights = built.deps.at(-1)!.heavyWeights!;
    const gib = 2 ** 30;
    const signals: MemorySignals = { level: "normal", freePct: 50, memsizeBytes: 16 * gib };
    const handle = tryAcquireLease({ ...o, level: scriptedPressureSampler("normal"), headroom: undefined }, { command: "npm test", cwd: "/w", weight: 2 * gib });
    try {
      expect(heavyWeights(3, signals)).toEqual({ used: 2 * gib, budget: 9 * gib });
      expect(heavyWeights(3, { level: "normal", freePct: 50 })).toBeUndefined();
    } finally {
      if (handle && "release" in handle) handle.release();
    }
  });
});
