import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuBusy, markElapsed, writeMark } from "../src/lease.js";
import type { CpuTicks, LeaseOptions } from "../src/lease.js";

describe("lease gate helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-helpers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cpu = (cpuTimes?: () => CpuTicks): LeaseOptions => ({ dir, cpuTimes }) as LeaseOptions;
  const reading = (at: number, busy: number | null) => writeFileSync(join(dir, "cpu.json"), JSON.stringify({ at, ticks: { idle: 100, total: 200 }, busy }));

  it.each([
    ["no tick reader", () => cpu(), 0],
    ["a tick read that throws", () => cpu(() => { throw new Error("no cpus"); }), 0],
    ["a cold cpu.json", () => cpu(() => ({ idle: 10, total: 20 })), null],
    ["a reading under 2 s old", () => (reading(9_000, 0.4), cpu(() => ({ idle: 10, total: 20 }))), 0.4],
    ["a stored null under 2 s old", () => (reading(9_000, null), cpu(() => ({ idle: 10, total: 20 }))), null],
    ["a reading 5 s old, whose ticks form the delta", () => (reading(5_000, 0.9), cpu(() => ({ idle: 150, total: 300 }))), 0.5],
    ["a reading older than 10 s", () => (reading(-5_000, 0.1), cpu(() => ({ idle: 150, total: 300 }))), null],
  ])("cpuBusy: %s", (_n, setUp, expected) => {
    expect(cpuBusy(setUp(), 10_000)).toBe(expected);
  });

  it.each([
    ["a missing mark", undefined, true],
    ["a mark under the window", 9_000, false],
    ["a mark at the window", 8_000, true],
    ["a future-dated mark", 20_000, true],
  ])("markElapsed: %s", (_n, markedAt, expected) => {
    if (markedAt !== undefined) {
      writeMark(dir, "m", markedAt);
    }
    expect(markElapsed(dir, "m", 10_000, 2_000)).toBe(expected);
  });
});
