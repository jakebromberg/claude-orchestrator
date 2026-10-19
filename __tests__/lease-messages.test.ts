import { describe, expect, it } from "vitest";
import { formatDiskFull, formatNoSlot, formatPostCheckStop, formatRefusal, refusalExitCode, refusalStopReason } from "../src/lease-messages.js";
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
