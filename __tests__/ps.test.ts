import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { ps, psField, psAncestors } from "../src/ps.js";

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: vi.fn() }));

const exec = vi.mocked(execFileSync);
/** Makes each successive `ps` call print the next value; `Error` entries throw. */
const answers = (...values: (string | Error)[]) =>
  exec.mockImplementation((() => {
    const v = values.shift();
    if (v instanceof Error) throw v;
    return `${v}\n`;
  }) as unknown as typeof execFileSync);

describe("ps", () => {
  beforeEach(() => exec.mockReset());

  it("bounds every call at 2 s and discards stderr, with the timeout overridable", () => {
    answers("1", "2", "3");
    ps(["-o", "x="]);
    psField(7, "ppid");
    ps(["-ax"], { timeoutMs: 60_000 });
    expect(exec.mock.calls.map(([cmd, , o]) => [cmd, (o as { timeout: number }).timeout, (o as { stdio: unknown }).stdio])).toEqual([
      ["ps", 2_000, ["ignore", "pipe", "ignore"]],
      ["ps", 2_000, ["ignore", "pipe", "ignore"]],
      ["ps", 60_000, ["ignore", "pipe", "ignore"]],
    ]);
    expect(exec.mock.calls[1]![1]).toEqual(["-o", "ppid=", "-p", "7"]);
  });

  it("returns trimmed output and lets a failure propagate", () => {
    answers("  42  ", new Error("boom"));
    expect(psField(1, "pgid")).toBe("42");
    expect(() => psField(1, "pgid")).toThrow("boom");
  });

  it("walks parents nearest first, stopping at pid 1", () => {
    answers("20", "1");
    expect(psAncestors(10, 32)).toEqual([10, 20]);
  });

  it("stops at the depth bound", () => {
    answers("20", "30", "40");
    expect(psAncestors(10, 2)).toEqual([10, 20]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("ends the walk with what it found when a lookup fails", () => {
    answers("20", new Error("gone"));
    expect(psAncestors(10, 32)).toEqual([10, 20]);
    exec.mockReset();
    answers(new Error("gone"));
    expect(psAncestors(10, 32)).toEqual([10]);
  });
});
