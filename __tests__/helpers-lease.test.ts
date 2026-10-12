import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLeaseClock, unwritableLeaseDir } from "./helpers/lease.js";

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
