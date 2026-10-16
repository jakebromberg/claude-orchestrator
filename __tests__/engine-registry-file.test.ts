import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEngineRegistry } from "../src/engine-registry.js";

const info = { runId: "run-1", logDir: "/tmp/c/logs", stallTimeout: 1800 };

describe("createFileEngineRegistry", () => {
  let dir: string;
  const file = () => join(dir, "engines", "4242.json");
  const read = () => JSON.parse(readFileSync(file(), "utf-8"));
  const make = (over: Partial<Parameters<typeof createFileEngineRegistry>[0]> = {}) =>
    createFileEngineRegistry({ dir, pid: 4242, pgid: () => 4000, now: () => new Date("2026-10-16T12:00:00Z"), ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-engine-registry-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the record at start and removes it at stop", () => {
    const registry = make();
    registry.start(info);
    expect(read()).toEqual({ pid: 4242, pgid: 4000, ...info, startedAt: "2026-10-16T12:00:00.000Z" });

    registry.stop();
    expect(existsSync(file())).toBe(false);
  });

  it("rewrites the record every 30 s and stops refreshing after stop", () => {
    const registry = make();
    registry.start(info);
    rmSync(file());

    vi.advanceTimersByTime(30_000);
    expect(existsSync(file())).toBe(true);

    registry.stop();
    vi.advanceTimersByTime(60_000);
    expect(existsSync(file())).toBe(false);
  });

  it("does not keep the process alive", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const registry = make();
    registry.start(info);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    registry.stop();
  });

  it("records a null pgid when it cannot be read", () => {
    make({ pgid: () => { throw new Error("no ps"); } }).start(info);
    expect(read().pgid).toBeNull();
  });

  it("swallows write and remove failures", () => {
    chmodSync(dir, 0o500);
    try {
      const registry = make();
      expect(() => registry.start(info)).not.toThrow();
      expect(() => registry.stop()).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
