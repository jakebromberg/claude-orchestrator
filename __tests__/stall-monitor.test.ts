import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StallMonitor } from "../src/stall-monitor.js";

describe("StallMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when stallTimeout is 0", () => {
    const onStall = vi.fn();
    const monitor = new StallMonitor({
      stallTimeout: 0,
      checkInterval: 1000,
      getLogSize: () => 100,
      onStall,
    });

    monitor.start();
    vi.advanceTimersByTime(10000);
    monitor.stop();

    expect(onStall).not.toHaveBeenCalled();
  });

  it("does not kill when log file grows within timeout", () => {
    let logSize = 100;
    const onStall = vi.fn();

    const monitor = new StallMonitor({
      stallTimeout: 5000,
      checkInterval: 1000,
      getLogSize: () => logSize,
      onStall,
    });

    monitor.start();

    // Log keeps growing each check interval
    vi.advanceTimersByTime(1000);
    logSize = 200;
    vi.advanceTimersByTime(1000);
    logSize = 300;
    vi.advanceTimersByTime(1000);
    logSize = 400;

    monitor.stop();
    expect(onStall).not.toHaveBeenCalled();
  });

  it("calls onStall when log file stops growing past timeout", () => {
    const onStall = vi.fn();

    const monitor = new StallMonitor({
      stallTimeout: 3000,
      checkInterval: 1000,
      getLogSize: () => 100, // constant size
      onStall,
    });

    monitor.start();

    // First check - records initial size (lastSize was -1), no stall yet
    vi.advanceTimersByTime(1000);
    expect(onStall).not.toHaveBeenCalled();

    // Second check - same size, 1000ms stalled
    vi.advanceTimersByTime(1000);
    expect(onStall).not.toHaveBeenCalled();

    // Third check - same size, 2000ms stalled
    vi.advanceTimersByTime(1000);
    expect(onStall).not.toHaveBeenCalled();

    // Fourth check - same size, 3000ms stalled >= timeout
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("resets stall counter when log grows", () => {
    let logSize = 100;
    const onStall = vi.fn();

    const monitor = new StallMonitor({
      stallTimeout: 3000,
      checkInterval: 1000,
      getLogSize: () => logSize,
      onStall,
    });

    monitor.start();

    // Stall for 2 checks
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // Log grows -> reset
    logSize = 200;
    vi.advanceTimersByTime(1000);

    // Stall again - only 1 check into new stall
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // Should not have fired yet (only 2 checks since reset)
    expect(onStall).not.toHaveBeenCalled();

    // Third check since last growth -> fires
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("stops monitoring when stop() is called", () => {
    const onStall = vi.fn();

    const monitor = new StallMonitor({
      stallTimeout: 2000,
      checkInterval: 1000,
      getLogSize: () => 100,
      onStall,
    });

    monitor.start();
    vi.advanceTimersByTime(1000);
    monitor.stop();

    // Advance past timeout
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("only fires onStall once", () => {
    const onStall = vi.fn();

    const monitor = new StallMonitor({
      stallTimeout: 2000,
      checkInterval: 1000,
      getLogSize: () => 100,
      onStall,
    });

    monitor.start();
    vi.advanceTimersByTime(5000);
    monitor.stop();

    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
