import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_STEP_TABLE, headroomCapacity, headroomStep, type HeadroomState, type StepTable } from "../src/headroom.js";
import type { MemorySignals, PressureLevel } from "../src/memory-pressure.js";
import * as barrel from "../src/index.js";

/** The owner's Q1 table (2026-10-15), the default. */
const Q1: StepTable = DEFAULT_STEP_TABLE;
const NOW = 1_000_000;
const HOLD = Q1.riseHoldMs;
const swap = { swapUsedBytes: 8e9, swapAllocatedBytes: 9e9, swapinsTotal: 0 };

type Row = [name: string, signals: MemorySignals, previous: HeadroomState | undefined, expected: HeadroomState];

describe("headroomStep under the Q1 table", () => {
  it.each<Row>([
    ["warning at the 40% edge", { level: "warning", freePct: 40 }, { step: 4, risingSince: null }, { step: 3, risingSince: null }],
    ["warning just under 40%", { level: "warning", freePct: 39 }, { step: 4, risingSince: null }, { step: 2, risingSince: null }],
    ["warning at the 30% edge", { level: "warning", freePct: 30 }, { step: 4, risingSince: null }, { step: 2, risingSince: null }],
    ["warning just under 30%", { level: "warning", freePct: 29 }, { step: 4, risingSince: null }, { step: 1, risingSince: null }],
    ["warning at 100% never exceeds 3", { level: "warning", freePct: 100 }, { step: 4, risingSince: null }, { step: 3, risingSince: null }],
    ["warning with no previous starts at its target", { level: "warning", freePct: 35 }, undefined, { step: 2, risingSince: null }],
    ["normal ignores free %", { level: "normal", freePct: 5 }, { step: 4, risingSince: null }, { step: 4, risingSince: null }],
    ["normal with no previous is 4", { level: "normal", freePct: 5 }, undefined, { step: 4, risingSince: null }],
    ["unknown reads as the ceiling", { level: "unknown" }, { step: 4, risingSince: null }, { step: 4, risingSince: null }],
    ["critical falls at once", { level: "critical", freePct: 60 }, { step: 4, risingSince: null }, { step: 0, risingSince: null }],
    ["critical from a failed read (the fallback's level) falls at once", { level: "critical" }, { step: 3, risingSince: NOW - 1 }, { step: 0, risingSince: null }],
    ["swap values present do not change the step", { level: "warning", freePct: 45, ...swap }, { step: 3, risingSince: null }, { step: 3, risingSince: null }],
    ["swap values absent do not change the step", { level: "warning", freePct: 45 }, { step: 3, risingSince: null }, { step: 3, risingSince: null }],
    ["a rise starts its hold", { level: "normal", freePct: 50 }, { step: 2, risingSince: null }, { step: 2, risingSince: NOW }],
    ["a rise held under riseHoldMs waits", { level: "normal", freePct: 50 }, { step: 2, risingSince: NOW - HOLD + 1 }, { step: 2, risingSince: NOW - HOLD + 1 }],
    ["a rise held for riseHoldMs gains one step and restarts the hold", { level: "normal", freePct: 50 }, { step: 2, risingSince: NOW - HOLD }, { step: 3, risingSince: NOW }],
    ["a rise of more than one step takes one step per hold", { level: "normal", freePct: 50 }, { step: 0, risingSince: NOW - 10 * HOLD }, { step: 1, risingSince: NOW }],
    ["the last step of a rise clears the hold", { level: "normal", freePct: 50 }, { step: 3, risingSince: NOW - HOLD }, { step: 4, risingSince: null }],
    ["a risingSince from the future restarts the hold", { level: "normal", freePct: 50 }, { step: 2, risingSince: NOW + 5_000 }, { step: 2, risingSince: NOW }],
    ["a fall mid-hold clears the hold", { level: "warning", freePct: 20 }, { step: 2, risingSince: NOW - 5_000 }, { step: 1, risingSince: null }],
  ])("%s", (_name, signals, previous, expected) => {
    expect(headroomStep(signals, previous, NOW, Q1)).toEqual(expected);
  });
});

describe("headroomStep with a previous it cannot trust", () => {
  const normal: MemorySignals = { level: "normal", freePct: 50 };
  const warning: MemorySignals = { level: "warning", freePct: 35 };

  it.each<[string, unknown]>([
    ["a NaN step", Number.NaN],
    ["a step of 7", 7],
    ["a step of -1", -1],
    ["a string step", "3"],
    ["a fractional step", 2.5],
  ])("treats %s as absent and starts at the target", (_name, step) => {
    const previous = { step, risingSince: null } as unknown as HeadroomState;
    expect(headroomStep(warning, previous, NOW, Q1)).toEqual({ step: 2, risingSince: null });
    expect(headroomStep(normal, previous, NOW, Q1)).toEqual({ step: 4, risingSince: null });
  });

  it.each<[string, unknown]>([
    ["a NaN risingSince", Number.NaN],
    ["an infinite risingSince", Number.POSITIVE_INFINITY],
    ["a negative infinite risingSince", Number.NEGATIVE_INFINITY],
    ["a string risingSince", "5"],
  ])("restarts the hold on %s", (_name, risingSince) => {
    const previous = { step: 2, risingSince } as unknown as HeadroomState;
    expect(headroomStep(normal, previous, NOW, Q1)).toEqual({ step: 2, risingSince: NOW });
  });
});

describe("headroomStep with a mistyped table", () => {
  it.each<[string, number, number]>([
    ["a band above the ceiling is clamped to 4", 7, 4],
    ["a negative band is clamped to 0", -2, 0],
  ])("%s", (_name, bandStep, expected) => {
    const table: StepTable = { warning: [{ minFreePct: 0, step: bandStep }], riseHoldMs: 0 };
    expect(headroomStep({ level: "warning", freePct: 10 }, undefined, NOW, table).step).toBe(expected);
  });
});

describe("headroomStep under the default table", () => {
  const cases: [PressureLevel, number, number][] = [
    ["normal", 10, 4], ["unknown", 10, 4], ["critical", 90, 0],
    ["warning", 100, 3], ["warning", 40, 3], ["warning", 39, 2], ["warning", 30, 2], ["warning", 29, 1], ["warning", 0, 1],
  ];

  it.each(cases)("%s at %i%% free is step %i", (level, freePct, step) => {
    expect(headroomStep({ level, freePct }, { step: 4, risingSince: null }, NOW, DEFAULT_STEP_TABLE).step).toBe(step);
  });

  it("holds a rise for 60 s", () => {
    expect(DEFAULT_STEP_TABLE.riseHoldMs).toBe(60_000);
    expect(headroomStep({ level: "normal", freePct: 90 }, { step: 0, risingSince: null }, NOW, DEFAULT_STEP_TABLE).step).toBe(0);
  });
});

describe("replay of the 2026-10-14 recording", () => {
  const rows: { at: number; level: PressureLevel; freePct: number }[] = readFileSync(
    new URL("./fixtures/headroom-replay/signals-2026-10-14.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const replay = (table: StepTable): number[] => {
    let state: HeadroomState | undefined;
    return rows.map((row) => (state = headroomStep(row, state, row.at, table)).step);
  };

  it("has the 40% edge among its warning samples", () => {
    const warning = rows.filter((r) => r.level === "warning").map((r) => r.freePct);
    expect(warning).toContain(40);
    expect(Math.min(...warning)).toBeGreaterThanOrEqual(30);
  });

  it("never exceeds step 3 at warning, and falls to 2 below 40% free", () => {
    const steps = replay(Q1);
    rows.forEach((row, i) => {
      if (row.level !== "warning") return;
      expect(steps[i]).toBeLessThanOrEqual(3);
      if (row.freePct < 40) expect(steps[i]).toBeLessThanOrEqual(2);
    });
  });

  it("rises one step per 60 s after the episode, not at once", () => {
    const steps = replay(Q1);
    const back = rows.findIndex((r, i) => i > 0 && r.level === "normal" && rows[i - 1]!.level === "warning");
    expect(steps[back - 1]).toBe(2);
    expect(steps[back]).toBe(2);
    expect(steps.at(-1)).toBe(4);
    expect(steps.slice(back).every((s, i, all) => i === 0 || (s - all[i - 1]! >= 0 && s - all[i - 1]! <= 1))).toBe(true);
  });
});

describe("headroomCapacity", () => {
  it.each<[step: number, ceiling: number, expected: number]>([
    [4, 4, 4],
    [4, 6, 6],
    [3, 6, 3],
    [2, 6, 2],
    [1, 6, 1],
    [0, 6, 0],
    [3, 2, 2],
  ])("step %i under a ceiling of %i gives %i slots", (step, heavyCeiling, expected) => {
    expect(headroomCapacity(step, { heavyCeiling, heavyWarning: 1 })).toBe(expected);
  });
});

describe("barrel", () => {
  it("exports the headroom step and the signals reader", () => {
    expect(barrel.headroomStep).toBe(headroomStep);
    expect(barrel.DEFAULT_STEP_TABLE).toBe(DEFAULT_STEP_TABLE);
    expect(typeof barrel.readMemorySignals).toBe("function");
    expect(barrel.headroomCapacity).toBe(headroomCapacity);
    expect(typeof barrel.defaultHeadroomSampler).toBe("function");
  });
});
