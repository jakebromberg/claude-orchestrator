import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

const { readMemoryPressure } = await import("../src/memory-pressure.js");

describe("the default sysctl reader", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("runs /usr/sbin/sysctl with its stderr discarded, so a failing sysctl cannot write to the caller's stderr", () => {
    execFileSync.mockReturnValue("2\n");
    expect(readMemoryPressure({ platform: "darwin" })).toBe("warning");
    expect(execFileSync).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], expect.objectContaining({ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  });

  it("reads a failing sysctl as no reading", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("sysctl: unknown oid");
    });
    expect(readMemoryPressure({ platform: "darwin" })).toBeNull();
  });
});
