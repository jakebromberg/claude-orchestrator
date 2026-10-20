import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseStatus } from "../src/lease.js";
import { plantTicket, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

describe("leaseStatus waiting", () => {
  let tmp: string;
  let lease: ScriptedLease;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-status-waiting-"));
    lease = scriptedLease(join(tmp, "lease"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("lists the eligible tickets in seq order with label, gated and ready, and leaves the other fields as they were", () => {
    plantTicket(lease, "b", 7, { label: "second", gated: true, ready: false });
    plantTicket(lease, "a", 3, { label: "first", gated: true, ready: true });
    plantTicket(lease, "c", 9, { label: "plain" });
    const status = leaseStatus(lease.opts());
    expect(status.waiting).toEqual([
      { seq: 3, label: "first", gated: true, ready: true },
      { seq: 7, label: "second", gated: true, ready: false },
      { seq: 9, label: "plain", gated: false },
    ]);
    expect(status).toMatchObject({ level: "normal", capacity: 1, step: 4, live: [] });
  });

  it("leaves out a stale ticket and a dead-pid one, and removes nothing", () => {
    plantTicket(lease, "live", 1, { label: "live" });
    plantTicket(lease, "stale", 2, { label: "stale" }, { ageMs: 60_000 });
    plantTicket(lease, "dead", 3, { label: "dead" }, { dead: true });
    expect(leaseStatus(lease.opts()).waiting?.map((t) => t.label)).toEqual(["live"]);
    for (const id of ["live", "stale", "dead"]) expect(existsSync(join(lease.dir, "waiting", `${id}.json`))).toBe(true);
  });

  it("leaves waiting out when no ticket waits, and creates nothing", () => {
    expect(leaseStatus(lease.opts())).not.toHaveProperty("waiting");
    expect(existsSync(lease.dir)).toBe(false);
  });
});
