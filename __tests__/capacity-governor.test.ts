import { describe, it, expect, vi } from "vitest";
import { createCapacityGovernor } from "../src/capacity-governor.js";
import type { PressureLevel, PressureSampler } from "../src/memory-pressure.js";
import type { Logger } from "../src/types.js";

function scripted(levels: PressureLevel[]): PressureSampler {
  let i = 0;
  const read = () => levels[Math.min(i++, levels.length - 1)];
  return Object.assign(read, { fresh: read });
}

function setUp(levels: PressureLevel[], adaptive = true, maxParallel = 4) {
  const clock = { t: 0 };
  const info = vi.fn();
  const logger = { info, warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() } as Logger;
  const governor = createCapacityGovernor({
    sampler: scripted(levels),
    maxParallel,
    adaptive,
    logger,
    now: () => clock.t,
  });
  return { governor, clock, info };
}

describe("createCapacityGovernor", () => {
  it("reads the level at creation: one at a time at warning, none at critical", () => {
    expect(setUp(["warning"]).governor.capacity()).toBe(1);
    expect(setUp(["critical"]).governor.capacity()).toBe(0);
    expect(setUp(["unknown"]).governor.capacity()).toBe(4);
  });

  it("holds the lower capacity until normal has lasted 60 s", () => {
    const { governor, clock } = setUp(["warning", "normal", "normal", "normal", "normal"]);
    expect(governor.capacity()).toBe(1);

    clock.t = 10_000;
    governor.tick(); // first normal reading starts the clock
    expect(governor.capacity()).toBe(1);

    clock.t = 69_999;
    governor.tick();
    expect(governor.capacity()).toBe(1);

    clock.t = 70_000;
    governor.tick();
    expect(governor.capacity()).toBe(4);
  });

  it("default clock is monotonic: a backward wall-clock step mid-hold does not extend the 60 s", () => {
    const wall = vi.spyOn(Date, "now");
    const mono = vi.spyOn(performance, "now");
    try {
      wall.mockReturnValue(1_000_000);
      mono.mockReturnValue(0);
      const governor = createCapacityGovernor({
        sampler: scripted(["warning", "normal", "normal"]),
        maxParallel: 4,
        adaptive: true,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), header: vi.fn() } as Logger,
      });
      governor.tick(); // calm starts
      wall.mockReturnValue(1_000_000 - 3_600_000); // wall clock steps back an hour
      mono.mockReturnValue(60_000);
      governor.tick();
      expect(governor.capacity()).toBe(4);
    } finally {
      wall.mockRestore();
      mono.mockRestore();
    }
  });

  it("restarts the 60 s when pressure returns mid-hold", () => {
    const { governor, clock } = setUp(["warning", "normal", "warning", "normal", "normal"]);
    clock.t = 10_000;
    governor.tick();
    clock.t = 20_000;
    governor.tick(); // back to warning: the calm window resets
    clock.t = 30_000;
    governor.tick(); // calm starts again at 30 s
    clock.t = 89_000;
    governor.tick();
    expect(governor.capacity()).toBe(1);
  });

  it("never opens capacity at critical, however far the clock advances", () => {
    const { governor, clock } = setUp(["critical"]);
    clock.t = 3_600_000;
    governor.tick();
    expect(governor.capacity()).toBe(0);
  });

  it("without adaptation ignores warning and hysteresis but still closes at critical", () => {
    const { governor, clock } = setUp(["warning", "critical", "normal"], false);
    expect(governor.capacity()).toBe(4);

    governor.tick();
    expect(governor.capacity()).toBe(0);

    clock.t = 10_000;
    governor.tick();
    expect(governor.capacity()).toBe(4);
  });

  it("logs each transition once", () => {
    const { governor, info } = setUp(["normal", "warning", "warning", "critical"]);
    governor.tick();
    governor.tick();
    governor.tick();
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0][0]).toContain("warning");
    expect(info.mock.calls[1][0]).toContain("critical");
  });
});
