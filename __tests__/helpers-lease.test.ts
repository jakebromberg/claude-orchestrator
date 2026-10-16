import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { defaultPressureSampler, leaseDirectory } from "../src/memory-pressure.js";
import { fakeLeaseClock, installIsolatedHome, isolatedLeaseEnv, scriptedLease, unwritableLeaseDir } from "./helpers/lease.js";

describe("isolatedLeaseEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("scrubs the parent's CO_LEASE_SESSION_SLOTS along with the rest of CO_LEASE_*", () => {
    vi.stubEnv("CO_LEASE_SESSION_SLOTS", "3");
    expect(isolatedLeaseEnv("/lease").CO_LEASE_SESSION_SLOTS).toBeUndefined();
    expect(isolatedLeaseEnv("/lease", { CO_LEASE_SESSION_SLOTS: "2" }).CO_LEASE_SESSION_SLOTS).toBe("2");
  });
});

describe("fakeLeaseClock().sleep", () => {
  afterEach(() => vi.useRealTimers());

  it("advances the clock, runs onSleep, then yields so an already-queued macrotask runs", async () => {
    const clock = fakeLeaseClock();
    const start = clock.now();
    const order: string[] = [];
    clock.onSleep = () => order.push("onSleep");
    setImmediate(() => order.push("macrotask"));
    await clock.sleep(50);
    order.push("resumed");
    expect(order).toEqual(["onSleep", "macrotask", "resumed"]);
    expect(clock.now()).toBe(start + 50);
    expect(clock.sleeps).toEqual([50]);
  });

  it("still resolves under fake timers", async () => {
    vi.useFakeTimers();
    const clock = fakeLeaseClock();
    await expect(clock.sleep(10)).resolves.toBeUndefined();
  });
});

describe("unwritableLeaseDir", () => {
  it("returns a path that cannot be created, and tolerates a second call with the same tmp", () => {
    const tmp = mkdtempSync(join(tmpdir(), "helpers-lease-"));
    try {
      const dir = unwritableLeaseDir(tmp);
      expect(unwritableLeaseDir(tmp)).toBe(dir);
      expect(() => mkdirSync(dir, { recursive: true })).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws EISDIR instead of returning a creatable path when blocker is a directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "helpers-lease-"));
    try {
      mkdirSync(join(tmp, "blocker"));
      expect(() => unwritableLeaseDir(tmp)).toThrow(expect.objectContaining({ code: "EISDIR" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("installIsolatedHome", () => {
  it("is installed for this test file: the default lease directory is under the guard's temp home", () => {
    expect(leaseDirectory({})).toMatch(/\/co-home-[^/]+\/\.local\/state\/claude-orchestrator\/lease$/);
  });

  it("removes CO_LEASE_* and CO_PRESSURE_* from process.env and restores them on dispose", () => {
    const outer = installIsolatedHome();
    try {
      process.env.CO_LEASE_DIR = "/elsewhere";
      process.env.CO_PRESSURE_OVERRIDE = "critical-as-warning";
      const isolated = installIsolatedHome();
      try {
        expect(process.env.CO_LEASE_DIR).toBeUndefined();
        expect(process.env.CO_PRESSURE_OVERRIDE).toBeUndefined();
      } finally {
        isolated.dispose();
      }
      expect(process.env.CO_LEASE_DIR).toBe("/elsewhere");
      expect(process.env.CO_PRESSURE_OVERRIDE).toBe("critical-as-warning");
    } finally {
      delete process.env.CO_LEASE_DIR;
      delete process.env.CO_PRESSURE_OVERRIDE;
      outer.dispose();
    }
  });

  // The guard's afterEach throws for this write; `fails` flips that into a pass, and fails if the guard stops throwing.
  // Writes only when the default lease directory is under the guard's temp home, so it can never touch a real directory.
  it.fails("the guard fails a test that writes under the default lease directory", () => {
    if (!/\/co-home-[^/]+\//.test(leaseDirectory({}))) throw new Error("guard not installed; refusing to write");
    defaultPressureSampler({}, { read: () => "normal", now: () => 1 })();
  });

  it("retire removes the temp home but keeps the redirects", () => {
    const isolated = installIsolatedHome();
    try {
      isolated.retire();
      expect(existsSync(isolated.home)).toBe(false);
      expect(leaseDirectory({})).toContain(isolated.home);
    } finally {
      isolated.dispose();
    }
  });

  it("points the default lease directory, via HOME, XDG_STATE_HOME or the account home, at a temp home, and restores on dispose", () => {
    const before = { home: process.env.HOME, xdg: process.env.XDG_STATE_HOME, userInfo: userInfo };
    const isolated = installIsolatedHome();
    try {
      const expected = join(isolated.home, ".local", "state", "claude-orchestrator", "lease");
      expect(isolated.home.startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(leaseDirectory({})).toBe(expected);
      expect(leaseDirectory({ HOME: "rel", XDG_STATE_HOME: "rel" })).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect(isolated.stray()).toEqual([]);
    } finally {
      isolated.dispose();
    }
    expect(existsSync(isolated.home)).toBe(false);
    expect(process.env.HOME).toBe(before.home);
    expect(process.env.XDG_STATE_HOME).toBe(before.xdg);
    expect(os.userInfo).toBe(before.userInfo);
  });

  it("reports what was written under the state directory and resets it", () => {
    const isolated = installIsolatedHome();
    try {
      const lease = leaseDirectory({});
      writeFileSync(join(lease, "level.json"), "{}");
      mkdirSync(join(lease, "..", "other"));
      expect(isolated.stray()).toEqual(["lease/level.json", "other"]);
      isolated.reset();
      expect(isolated.stray()).toEqual([]);
      expect(existsSync(lease)).toBe(true);
    } finally {
      isolated.dispose();
    }
  });

  it("reports a lease directory that was removed or replaced by a file", () => {
    const isolated = installIsolatedHome();
    try {
      rmSync(leaseDirectory({}), { recursive: true });
      expect(isolated.stray()).toEqual(["lease (missing)"]);
    } finally {
      isolated.dispose();
    }
  });
});

describe("scriptedLease", () => {
  it("builds options on the fake clock, with liveness over `alive` and events and warnings collected", async () => {
    const lease = scriptedLease("/unused", { level: "warning", alive: [11] });
    const o = lease.opts();
    expect(o.dir).toBe("/unused");
    expect(o.policy).toEqual({ heavyCeiling: 1, heavyWarning: 1 });
    expect(o.level?.()).toBe("warning");
    expect(o.now?.()).toBe(lease.clock.ms);
    await o.sleep?.(5);
    expect(lease.clock.sleeps).toEqual([5]);
    expect([o.isAlive?.(11), o.isAlive?.(12)]).toEqual([true, false]);
    lease.alive.add(12);
    expect(o.isAlive?.(12)).toBe(true);
    o.onEvent?.({ type: "fail-open", reason: "x" } as never);
    o.warn?.("w");
    expect(lease.events).toHaveLength(1);
    expect(lease.warnings).toEqual(["w"]);
  });

  it("treats this process as alive by default, reads a level function on every call, and takes the stale-cache reading for fresh()", () => {
    let level: "normal" | "critical" = "normal";
    const lease = scriptedLease("/unused", { level: () => level, fresh: () => "warning" });
    const sampler = lease.opts().level!;
    expect(lease.opts().isAlive?.(process.pid)).toBe(true);
    expect(sampler()).toBe("normal");
    level = "critical";
    expect([sampler(), sampler.fresh()]).toEqual(["critical", "warning"]);
  });

  it("applies per-call overrides, and an explicit undefined drops the scripted field", () => {
    const lease = scriptedLease("/unused");
    expect(lease.opts({ policy: { heavyCeiling: 3, heavyWarning: 2 } }).policy).toEqual({ heavyCeiling: 3, heavyWarning: 2 });
    // The key itself goes, so a caller spreading these options over its defaults keeps the real field.
    expect(lease.opts({ level: undefined })).not.toHaveProperty("level");
    const defaults: Record<string, unknown> = { level: "real" };
    expect({ ...defaults, ...lease.opts({ level: undefined }) }.level).toBe("real");
  });
});
