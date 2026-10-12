import { describe, it, expect } from "vitest";
import { scriptedPressureSampler } from "../src/testing.js";
import type { PressureLevel } from "../src/memory-pressure.js";

describe("scriptedPressureSampler", () => {
  it.each<[string, Parameters<typeof scriptedPressureSampler>[0], PressureLevel[]]>([
    ["a fixed level", "warning", ["warning", "warning", "warning"]],
    ["a list that advances one level per reading", ["normal", "warning", "critical"], ["normal", "warning", "critical"]],
    ["a list that holds its last level", ["normal", "critical"], ["normal", "critical", "critical", "critical"]],
  ])("reads %s", (_name, levels, expected) => {
    const sampler = scriptedPressureSampler(levels);
    expect(expected.map(() => sampler())).toEqual(expected);
  });

  it("reads a function's level on every call, so a test can change it between readings", () => {
    let level: PressureLevel = "normal";
    const sampler = scriptedPressureSampler(() => level);
    expect(sampler()).toBe("normal");
    level = "critical";
    expect(sampler()).toBe("critical");
  });

  it("shares the script with fresh() by default, and lets fresh() disagree with the cached reading when asked", () => {
    const shared = scriptedPressureSampler(["normal", "warning"]);
    expect([shared(), shared.fresh()]).toEqual(["normal", "warning"]);
    const stale = scriptedPressureSampler("critical", { fresh: () => "normal" });
    expect([stale(), stale.fresh()]).toEqual(["critical", "normal"]);
  });

  it.each([
    [undefined, false, undefined],
    [true, true, true],
    [false, true, false],
  ])("has overridden() only when asked for (option %s)", (overridden, present, value) => {
    const sampler = scriptedPressureSampler("warning", { overridden });
    expect("overridden" in sampler).toBe(present);
    expect(sampler.overridden?.()).toBe(value);
  });
});
