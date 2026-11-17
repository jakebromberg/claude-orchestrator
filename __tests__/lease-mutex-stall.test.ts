import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

// Issue #324, defect 1. On 2026-11-16 events.jsonl holds 30 `fail-open` / `mutex-busy` events in seven bursts; four of
// the bursts follow a gap of 91 s to 190 s in the machine-wide pressure heartbeat, which any polling waiter refreshes
// every 60 s, so every waiter was stopped at once and resumed together. `busySince` was a wall-clock instant set at the
// first busy poll, so a process stopped between two polls read the next busy poll as "busy for 30 s in a row"
// and admitted itself unchecked, whatever the weights or step said.

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
