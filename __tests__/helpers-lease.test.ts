import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { leaseDirectory } from "../src/memory-pressure.js";
import { fakeLeaseClock, installIsolatedHome, unwritableLeaseDir } from "./helpers/lease.js";

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
