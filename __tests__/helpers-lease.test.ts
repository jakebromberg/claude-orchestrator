import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLeaseClock } from "./helpers/lease.js";

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
