import { describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ deps: [] as ({ log?: (msg: string) => void } | undefined)[] }));
vi.mock("../src/memory-pressure.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/memory-pressure.js")>();
  return {
    ...real,
    defaultPressureSampler: (env: NodeJS.ProcessEnv, deps?: { log?: (msg: string) => void }) => {
      built.deps.push(deps);
      return real.defaultPressureSampler(env, deps);
    },
  };
});

const { scriptedPressureSampler } = await import("../src/testing.js");
const { defaultLeaseOptions } = await import("../src/lease.js");

describe("defaultLeaseOptions sampler wiring", () => {
  it("hands the sampler it builds a log that reaches the caller's warn", () => {
    const warn = vi.fn();
    defaultLeaseOptions({ CO_LEASE_DIR: "/lease" }, { warn });
    built.deps.at(-1)?.log?.("x");
    expect(warn).toHaveBeenCalledWith("memory-pressure: x");
  });

  it("builds no sampler when the caller supplies one", () => {
    built.deps.length = 0;
    const level = scriptedPressureSampler("normal", { overridden: false });
    expect(defaultLeaseOptions({ CO_LEASE_DIR: "/lease" }, { level }).level).toBe(level);
    expect(built.deps).toEqual([]);
  });
});
