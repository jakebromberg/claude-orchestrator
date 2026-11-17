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

// Issue #324 review: refusals the UI-test class gives that are not a full line, each with its own text instead of the no-slot line.
describe("UI-test refusals", () => {
  const ui = (refused: LeaseRefusal["refused"]): LeaseRefusal => ({ refused, waitedMs: 61_000, level: "normal", live: 1, code: "EACCES", class: "ui-tests" });

  it.each([
    { refused: "io-error" as const, has: ["lease directory", "61s", "EACCES", "rerun"] },
    { refused: "slot-lost" as const, has: ["UI-test slot was lost", "rerun"] },
    { refused: "nested-ui-test" as const, has: ["lease slot", "deadlock", "own Bash call"] },
  ])("$refused has its own line, exit code 75 and the no-slot prefix", ({ refused, has }) => {
    const text = formatRefusal(ui(refused), status);
    for (const part of has) expect(text).toContain(part);
    // Static refusals say that rerunning cannot help; the others are lease waits the caller reruns.
    if (refused === "nested-ui-test") expect(text).toContain("rerunning the same command will not help");
    // The standard prefix, so the "stop after the second no-slot denial" rule and a give-up rule that matches it count this refusal too.
    expect(text.startsWith("lease: no slot after 61s")).toBe(true);
    expect(refusalExitCode(ui(refused))).toBe(75);
    expect(formatPostCheckStop(ui(refused))).toContain("UI-test");
    expect(formatPostCheckStop(ui(refused))).not.toContain("memory pressure");
    expect(formatPostCheckStop(ui(refused))).not.toContain("will not be retried");
  });

  it("a backgrounded UI run's refusal starts with the no-slot prefix, and is a configuration error, not a lease wait", () => {
    const refusal: LeaseRefusal = { refused: "backgrounded-ui-test", waitedMs: 0, level: "normal", live: 0, class: "ui-tests" };
    expect(formatRefusal(refusal, status)).toMatch(/^lease: no slot after 0s: run a UI test in the foreground/);
    expect(refusalExitCode(refusal)).toBe(75);
    expect(refusalStopReason(refusal)).toBe("config-error");
    expect(formatPostCheckStop(refusal)).toContain("run a UI test in the foreground");
  });

  it.each(["io-error", "slot-lost", "nested-ui-test", "ui-test-running"] as const)("%s, with or without pids, starts with `lease: no slot after <n>s`", (refused) => {
    for (const pids of [undefined, [4242]]) {
      const text = formatRefusal({ refused, waitedMs: 12_300, level: "normal", live: 0, class: "ui-tests", ...(pids && { pids }) }, status);
      expect(text).toMatch(/^lease: no slot after 12s[:( ]/);
    }
  });

  it("says an unmanaged UI-test run is in progress, with its pids, in the no-slot line and the refusal of a run that could not be ruled out", () => {
    const busy: LeaseRefusal = { refused: "max-wait", waitedMs: 61_000, level: "normal", live: 0, class: "ui-tests", pids: [4242, 4243] };
    expect(formatRefusal(busy, status)).toContain("UI-test run that holds no slot is in progress (pid 4242, 4243)");
    expect(formatRefusal(busy, status)).toContain("lease: no slot after 61s");
    const running: LeaseRefusal = { refused: "ui-test-running", waitedMs: 11_000, level: "normal", live: 0, class: "ui-tests", pids: [777] };
    expect(formatRefusal(running, status)).toContain("UI-test run is in progress (pid 777)");
    const unknown: LeaseRefusal = { refused: "ui-test-running", waitedMs: 400_000, level: "normal", live: 0, class: "ui-tests" };
    expect(formatRefusal(unknown, status)).toContain("could not tell whether a UI-test run is in progress");
    expect(refusalExitCode(running)).toBe(75);
    expect(refusalStopReason(running)).toBe("lease-wait");
    expect(refusalStopReason(unknown)).toBe("lease-wait");
    expect(formatPostCheckStop(running)).toContain("UI-test slot");
  });

  it.each(["io-error", "slot-lost", "nested-ui-test"] as const)("%s is a lease-wait stop, not memory-critical, so it is not recorded as memory pressure", (refused) => {
    expect(refusalStopReason(ui(refused))).toBe("lease-wait");
  });
});
