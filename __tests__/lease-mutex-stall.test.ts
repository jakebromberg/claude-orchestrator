import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

// Issue #324, defect 1. On 2026-11-16 events.jsonl holds 30 `fail-open` / `mutex-busy` events in seven bursts. The machine-wide
// pressure heartbeat, which any polling waiter refreshes every 60 s, has 34 gaps of 76 s or more that day; 24 of the 30 fail-opens fall
// inside a gap and 6 within 60 s after one ends, but only 10 of the 34 gaps have any (a gap of 835 s and one of 245 s have none), so the
// data is consistent with whole-machine stalls and does not prove them. The mechanism does not need the proof: `busySince` was a wall-clock
// instant set at the first busy poll, so a process stopped between two polls read the next busy poll as "busy for 30 s in a row" and
// admitted itself unchecked, whatever the weights or step said. The first test reproduces exactly that.

const meta: HolderMeta = { command: "npm test", cwd: "/work" };
const isLeased = (r: unknown): r is LeaseHandle => (r as LeaseHandle).leased === true;

describe("a busy mutex is waited out, never failed open (issue #324)", () => {
  let tmp: string;
  let lease: ScriptedLease;
  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts(over);
  const mutex = (): string => join(lease.dir, ".mutex");
  const touchMutex = (): void => utimesSync(mutex(), lease.clock.ms / 1000, lease.clock.ms / 1000);
  const busyMutex = (): void => {
    tryAcquireLease(opts(), meta)!.release();
    writeFileSync(mutex(), "");
    touchMutex();
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-stall-"));
    lease = scriptedLease(join(tmp, "lease"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("keeps waiting when the process is stopped between two busy polls, and takes a real slot when the mutex frees", async () => {
    busyMutex();
    let sleeps = 0;
    lease.clock.onSleep = () => {
      sleeps++;
      // The machine stalls for ten minutes during the first sleep; the mutex's holder is alive and refreshes it.
      if (sleeps === 1) lease.clock.ms += 600_000;
      if (sleeps < 3) touchMutex();
      else rmSync(mutex(), { force: true });
    };
    const r = await acquireLease(opts(), meta);
    expect(isLeased(r) && r.id).toEqual(expect.any(String));
    expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
    expect(lease.warnings).toEqual([]);
    (r as LeaseHandle).release();
  });

  it("keeps waiting while the mutex stays busy for minutes, until maxWaitMs refuses", async () => {
    busyMutex();
    lease.clock.onSleep = touchMutex;
    const r = await acquireLease(opts(), meta, { maxWaitMs: 300_000 });
    expect(r).toMatchObject({ refused: "max-wait" });
    expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
    expect(lease.warnings).toEqual([]);
  });

  it("does the same for the session class, which shares the mutex", async () => {
    const { acquireSessionLease } = await import("../src/lease.js");
    busyMutex();
    lease.clock.onSleep = touchMutex;
    const r = await acquireSessionLease(opts(), { command: "engine", cwd: "/work" }, { maxWaitMs: 300_000 });
    expect(r).toMatchObject({ refused: "max-wait" });
    expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
  });
});
