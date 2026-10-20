import { describe, expect, it, vi } from "vitest";
import { throttledProgress, formatDiskFull, formatNoSlot, formatPostCheckStop, formatRefusal, refusalExitCode, refusalStopReason } from "../src/lease-messages.js";
import type { LeaseRefusal, LeaseStatus } from "../src/lease.js";

const status = { capacity: 1, live: [{ pid: 7, command: "npm test" }] } as unknown as LeaseStatus;
const refusal = (refused: LeaseRefusal["refused"]): LeaseRefusal => ({ refused, waitedMs: 5000, level: "warning", live: 1, code: "ENOSPC" });

describe("lease refusal classifier", () => {
  it.each([
    { refused: "max-wait" as const, text: formatNoSlot(refusal("max-wait"), status), reason: "memory-critical", exit: 75 },
    { refused: "stopped" as const, text: formatNoSlot(refusal("stopped"), status), reason: "memory-critical", exit: 75 },
    { refused: "disk-full" as const, text: formatDiskFull(refusal("disk-full")), reason: "disk-full", exit: 74 },
  ])("$refused: text, stop reason and exit code", ({ refused, text, reason, exit }) => {
    expect(formatRefusal(refusal(refused), status)).toBe(text);
    expect(refusalStopReason(refusal(refused))).toBe(reason);
    expect(refusalExitCode(refusal(refused))).toBe(exit);
  });
});

describe("formatPostCheckStop", () => {
  it.each([
    { refused: "max-wait" as const, text: "post-check: skipped because memory pressure is critical (critical, 0 live); the check did not run and will not be retried" },
    { refused: "stopped" as const, text: "post-check: skipped because memory pressure is critical (critical, 0 live); the check did not run and will not be retried" },
    { refused: "disk-full" as const, text: `Post-session check not run: ${formatDiskFull(refusal("disk-full"))}` },
  ])("$refused: pins the summary", ({ refused, text }) => {
    const got = formatPostCheckStop({ ...refusal(refused), level: "critical", live: 0 });
    expect(got).toBe(text);
    if (refused !== "disk-full") {
      expect(got).not.toContain("lease: no slot after");
      expect(got).not.toContain("rerun");
    }
  });
});

describe("throttledProgress", () => {
  it.each([
    { name: "writes on the first poll, then every 60 s", opts: undefined, polls: [0, 30_000, 59_999, 60_000, 90_000, 120_000], written: [0, 60_000, 120_000] },
    { name: "skipFirst waits 60 s for the first line", opts: { skipFirst: true }, polls: [0, 30_000, 59_999, 60_000, 90_000, 120_000], written: [60_000, 120_000] },
    { name: "skipFirst writes a first poll that is already past 60 s", opts: { skipFirst: true }, polls: [75_000, 100_000, 135_000], written: [75_000, 135_000] },
  ])("$name", ({ opts, polls, written }) => {
    const out: number[] = [];
    const onWait = throttledProgress((s: { waitedMs: number }) => void out.push(s.waitedMs), opts);
    for (const waitedMs of polls) onWait({ waitedMs });
    expect(out).toEqual(written);
  });

  it("swallows a throwing writer and still throttles", () => {
    const write = vi.fn(() => {
      throw new Error("stderr closed");
    });
    const onWait = throttledProgress(write);
    expect(() => [0, 10_000, 60_000].forEach((waitedMs) => onWait({ waitedMs }))).not.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
