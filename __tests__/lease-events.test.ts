import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLeaseOptions, tryAcquireLease, type LeaseEvent } from "../src/lease.js";
import { leaseEventSink } from "../src/lease-events.js";
import * as barrel from "../src/index.js";

const TS = Date.UTC(2026, 9, 11, 12, 0, 0);
const ISO = "2026-10-11T12:00:00.000Z";

describe("leaseEventSink", () => {
  let tmp: string;
  let dir: string;
  const lines = (name = "events.jsonl"): unknown[] =>
    readFileSync(join(dir, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-events-"));
    dir = join(tmp, "lease");
    mkdirSync(dir);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.each<[string, LeaseEvent]>([
    ["acquire", { type: "acquire", id: "1-ab", waitedMs: 40, level: "warning", live: 2, capacity: 2 }],
    ["acquire with override", { type: "acquire", id: "1-ab", waitedMs: 0, level: "warning", live: 1, capacity: 1, override: true }],
    ["release", { type: "release", id: "1-ab", heldMs: 900, exitCode: 0 }],
    ["max-wait timeout", { type: "timeout", refused: "max-wait", waitedMs: 5_000 }],
    ["stopped timeout", { type: "timeout", refused: "stopped", waitedMs: 3_000, level: "critical" }],
    ["stale-heartbeat reap", { type: "reap", id: "2-cd", reason: "stale-heartbeat" }],
    ["orphan-bound reap", { type: "reap", id: "2-cd", reason: "orphan-bound" }],
    ["corrupt reap", { type: "reap", id: "2-cd", reason: "corrupt" }],
    ["io-error fail-open", { type: "fail-open", reason: "io-error", waitedMs: 0, code: "EACCES", message: "denied" }],
    ["mutex-busy fail-open", { type: "fail-open", reason: "mutex-busy", waitedMs: 30_000 }],
    ["unknown future reap reason", { type: "reap", id: "3-ef", reason: "dead-session" as never }],
  ])("writes %s as it is, plus ts", (_name, event) => {
    leaseEventSink(dir, { now: () => TS })(event);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe(`${JSON.stringify({ ts: ISO, ...event })}\n`);
  });

  it("appends one line per event", () => {
    const sink = leaseEventSink(dir, { now: () => TS });
    sink({ type: "reap", id: "1-ab", reason: "stale-heartbeat" });
    sink({ type: "release", id: "1-ab", heldMs: 5 });
    expect(lines().map((l) => (l as { type: string }).type)).toEqual(["reap", "release"]);
  });

  it("creates nothing when the lease directory does not exist", () => {
    const missing = join(tmp, "never");
    leaseEventSink(missing)({ type: "release", id: "1-ab", heldMs: 5 });
    expect(existsSync(missing)).toBe(false);
  });

  it("rotates once past the threshold into a single events.jsonl.1, replacing the previous one", () => {
    const sink = leaseEventSink(dir, { now: () => TS, maxBytes: 100 });
    const event: LeaseEvent = { type: "release", id: "1-ab", heldMs: 1 };
    writeFileSync(join(dir, "events.jsonl.1"), "old generation\n");
    while (!existsSync(join(dir, "events.jsonl.1")) || readFileSync(join(dir, "events.jsonl.1"), "utf8") === "old generation\n") sink(event);
    sink({ type: "reap", id: "9-zz", reason: "corrupt" });
    expect(readdirSync(dir).sort()).toEqual(["events.jsonl", "events.jsonl.1"]);
    expect(lines().at(-1)).toEqual({ ts: ISO, type: "reap", id: "9-zz", reason: "corrupt" });
    expect(lines().length).toBeLessThanOrEqual(2);
    expect((lines("events.jsonl.1") as { type: string }[]).every((l) => l.type === "release")).toBe(true);
  });

  it("swallows a write failure", () => {
    mkdirSync(join(dir, "events.jsonl")); // appending to a directory fails
    expect(() => leaseEventSink(dir)({ type: "release", id: "1-ab", heldMs: 5 })).not.toThrow();
  });

  describe("wiring", () => {
    it("defaultLeaseOptions records the lease's own events once the directory exists", () => {
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
      const h = tryAcquireLease({ ...o, level: Object.assign(() => "normal" as const, { fresh: () => "normal" as const }) }, { command: "npm test", cwd: "/w" })!;
      h.release({ exitCode: 0 });
      expect((lines() as { type: string }[]).map((l) => l.type)).toEqual(["acquire", "release"]);
    });

    it("an unwritable log never fails an acquire", () => {
      mkdirSync(join(dir, "events.jsonl"));
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir });
      const h = tryAcquireLease({ ...o, level: Object.assign(() => "normal" as const, { fresh: () => "normal" as const }) }, { command: "npm test", cwd: "/w" });
      expect(h?.leased).toBe(true);
      h!.release();
    });

    it("is exported from the barrel", () => {
      expect(barrel.leaseEventSink).toBe(leaseEventSink);
    });
  });
});
