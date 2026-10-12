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

const { defaultLeaseOptions } = await import("../src/lease.js");

describe("defaultLeaseOptions sampler wiring", () => {
  it("hands the sampler it builds the caller's warn as its log", () => {
    const warn = vi.fn();
    defaultLeaseOptions({ CO_LEASE_DIR: "/lease" }, { warn });
    expect(built.deps.at(-1)?.log).toBe(warn);
  });

  it("builds no sampler when the caller supplies one", () => {
    built.deps.length = 0;
    const level = Object.assign(() => "normal" as const, { fresh: () => "normal" as const, overridden: () => false });
    expect(defaultLeaseOptions({ CO_LEASE_DIR: "/lease" }, { level }).level).toBe(level);
    expect(built.deps).toEqual([]);
  });
});
