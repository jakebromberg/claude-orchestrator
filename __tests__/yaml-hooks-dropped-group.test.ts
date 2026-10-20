import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  groupAlive: vi.fn<(pgid: number) => boolean>(),
  signalGroup: vi.fn<(pgid: number, signal: NodeJS.Signals) => boolean>(),
  children: [] as unknown[],
}));

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    h.children.push(child);
    return child;
  }),
}));

vi.mock("../src/ps.js", async (orig) => ({
  ...(await orig<typeof import("../src/ps.js")>()),
  groupAlive: h.groupAlive,
  signalGroup: h.signalGroup,
}));

import { runShellAsync } from "../src/yaml-hooks.js";

type FakeChild = EventEmitter;

describe("runShellAsync signalling a dropped process group", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.children.length = 0;
    h.groupAlive.mockReset();
    h.signalGroup.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    // Settle every fake child so no pgid stays in the module-wide live set for the next case.
    h.groupAlive.mockReturnValue(false);
    for (const child of h.children as FakeChild[]) child.emit("exit", 0, null);
    vi.useRealTimers();
  });

  it("does not probe or poll the pgid again on a later 'close' once this call dropped it", async () => {
    h.groupAlive.mockReturnValue(false);
    const run = runShellAsync("x", "/", undefined, undefined, 60_000, 100);
    (h.children[0] as FakeChild).emit("exit", 0, null);
    // Another command now owns the reused pgid and its group is live.
    h.groupAlive.mockReset().mockReturnValue(true);
    (h.children[0] as FakeChild).emit("close", 0, null);
    await run;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.groupAlive).not.toHaveBeenCalled();
  });

  it("signals a group that is still live: SIGTERM at the deadline, SIGKILL after the grace", async () => {
    h.groupAlive.mockReturnValue(true);
    const run = runShellAsync("x", "/", undefined, undefined, 1_000, 100);
    const outcome = run.then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.signalGroup.mock.calls).toEqual([[4242, "SIGTERM"]]);
    expect(await outcome).toContain("timed out");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.signalGroup.mock.calls).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    (h.children[0] as FakeChild).emit("close", null, "SIGTERM");
  });

  it("never signals after this call dropped the group, even when another command re-adds the same pgid", async () => {
    h.groupAlive.mockReturnValue(false);
    const run = runShellAsync("x", "/", undefined, undefined, 1_000, 100);
    const outcome = run.then(() => "resolved", (e: Error) => e.message);
    // The shell exits with no member left: settleGroup drops pgid 4242 from the live set.
    (h.children[0] as FakeChild).emit("exit", 0, null);
    // A later bounded command reuses the id and re-adds it to the live set.
    h.groupAlive.mockReturnValue(true);
    const later = runShellAsync("y", "/", undefined, undefined, 60_000, 100);
    later.catch(() => {});
    expect(h.children).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000 + 100);
    expect(await outcome).toContain("timed out");
    expect(h.signalGroup).not.toHaveBeenCalled();

    h.groupAlive.mockReturnValue(false);
    (h.children[1] as FakeChild).emit("exit", 0, null);
    (h.children[1] as FakeChild).emit("close", 0, null);
    await later;
  });
});
