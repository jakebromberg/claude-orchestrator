import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseStatus } from "../src/lease.js";
import { plantHolder, plantTicket, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

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

  it("lists a high ticket first whatever its seq, with its priority, and keeps seq order within a priority", () => {
    plantTicket(lease, "n3", 3, { label: "normal-3" });
    plantTicket(lease, "h9", 9, { label: "high-9", priority: "high", gated: true, ready: true });
    plantTicket(lease, "n1", 1, { label: "normal-1" });
    plantTicket(lease, "h5", 5, { label: "high-5", priority: "high" });
    plantTicket(lease, "w7", 7, { label: "wrong-type", priority: 1 });
    expect(leaseStatus(lease.opts()).waiting).toEqual([
      { seq: 5, label: "high-5", gated: false, priority: "high" },
      { seq: 9, label: "high-9", gated: true, ready: true, priority: "high" },
      { seq: 1, label: "normal-1", gated: false },
      { seq: 3, label: "normal-3", gated: false },
      { seq: 7, label: "wrong-type", gated: false },
    ]);
  });

  it.each<[string, unknown, boolean]>([
    ["no priority", undefined, false],
    ["an unknown priority string", "urgent", false],
    ["a priority of normal", "normal", false],
    ["a priority of the wrong type (number)", 1, false],
    ["a priority of the wrong type (true)", true, false],
    ["a priority of high", "high", true],
  ])("shows a holder's priority only when it is high: a holder file with %s", (_name, priority, shown) => {
    plantHolder(lease, "h", { pid: 4242, ...(priority !== undefined && { priority }) });
    lease.alive.add(4242);
    const [holder] = leaseStatus(lease.opts()).live;
    expect(holder).toBeDefined();
    if (shown) expect(holder).toHaveProperty("priority", "high");
    else expect(holder).not.toHaveProperty("priority");
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
