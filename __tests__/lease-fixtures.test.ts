import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpuBusy } from "../src/lease.js";
import { plantCpu, plantHolder, plantTicket, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

describe("lease directory fixtures", () => {
  let tmp: string;
  let lease: ScriptedLease;
  const read = (rel: string) => JSON.parse(readFileSync(join(lease.dir, rel), "utf8"));
  const mtimeMs = (rel: string): number => statSync(join(lease.dir, rel)).mtimeMs;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-fixtures-"));
    lease = scriptedLease(join(tmp, "lease"), { alive: [] });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("plantHolder writes the required fields on the scripted clock, with the mtime half a millisecond into the heartbeat's millisecond", () => {
    plantHolder(lease, "4242-a", { weight: 7 }, { beatAgoMs: 1000 });
    expect(read("holders/4242-a.json")).toEqual({ id: "4242-a", pid: 4242, command: "x", cwd: "/", startedAt: lease.clock.ms, level: "normal", weight: 7 });
    expect(mtimeMs("holders/4242-a.json")).toBeCloseTo(lease.clock.ms - 1000 + 0.5, 0);
    expect(statSync(join(lease.dir, "holders")).mode & 0o777).toBe(0o700);
  });

  it("plantHolder lets the record override a default and writes into another subdirectory", () => {
    plantHolder(lease, "x", { pid: 9, startedAt: 5 }, { sub: "sessions" });
    expect(read("sessions/x.json")).toMatchObject({ id: "x", pid: 9, startedAt: 5 });
  });

  it("plantTicket writes a ticket aged on the clock and marks its pid alive unless dead", () => {
    plantTicket(lease, "t1", 1, { gated: true }, { ageMs: 4000 });
    plantTicket(lease, "t2", 2, {}, { dead: true });
    expect(read("waiting/t1.json")).toEqual({ seq: 1, id: "t1", pid: 5001, label: "other", gated: true });
    expect(mtimeMs("waiting/t1.json")).toBeCloseTo(lease.clock.ms - 4000, 0);
    expect(lease.alive.has(5001)).toBe(true);
    expect(lease.alive.has(5002)).toBe(false);
  });

  it.each([0.4, null])("plantCpu stores a reading dated at the clock, so cpuBusy returns %s as stored", (busy) => {
    plantCpu(lease, busy);
    expect(cpuBusy({ dir: lease.dir, cpuTimes: () => ({ idle: 100, total: 200 }) } as never, lease.clock.ms)).toBe(busy);
  });
});
