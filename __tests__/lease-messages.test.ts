import { describe, expect, it } from "vitest";
import { formatDiskFull, formatNoSlot, formatRefusal, refusalExitCode, refusalStopReason } from "../src/lease-messages.js";
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
