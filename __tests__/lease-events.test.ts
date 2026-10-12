import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { defaultLeaseOptions, tryAcquireLease, type LeaseEvent } from "../src/lease.js";
import { leaseEventSink } from "../src/lease-events.js";
import * as barrel from "../src/index.js";

const TS = Date.UTC(2026, 9, 11, 12, 0, 0);
const ISO = "2026-10-11T12:00:00.000Z";
const RELEASE: LeaseEvent = { type: "release", id: "1-ab", heldMs: 5 };
const normal = Object.assign(() => "normal" as const, { fresh: () => "normal" as const });
const noFifos = process.platform === "win32";

/**
 * Times `fn` while a worker opens `fifo` for reading after 1 s. That frees an open blocked waiting for a reader, so a
 * sink that blocks fails the test instead of hanging the suite.
 */
async function timedBesideFifo(fifo: string, fn: () => void): Promise<number> {
  const watchdog = new Worker(
    `const fs = require("node:fs"); setTimeout(() => fs.openSync(${JSON.stringify(fifo)}, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK), 1000);`,
    { eval: true },
  );
  const start = Date.now();
  try {
    fn();
    return Date.now() - start;
  } finally {
    await watchdog.terminate();
  }
}

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
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

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
    const rotated = (): boolean => readFileSync(join(dir, "events.jsonl.1"), "utf8") !== "old generation\n";
    for (let i = 0; i < 10 && !rotated(); i++) sink(event);
    expect(rotated()).toBe(true);
    sink({ type: "reap", id: "9-zz", reason: "corrupt" });
    expect(readdirSync(dir).sort()).toEqual(["events.jsonl", "events.jsonl.1"]);
    expect(lines().at(-1)).toEqual({ ts: ISO, type: "reap", id: "9-zz", reason: "corrupt" });
    expect(lines().length).toBeLessThanOrEqual(2);
    expect((lines("events.jsonl.1") as { type: string }[]).every((l) => l.type === "release")).toBe(true);
  });

  it("still appends when the rotation rename fails, and warns once", () => {
    mkdirSync(join(dir, "events.jsonl.1", "occupied"), { recursive: true }); // a rename onto a non-empty directory fails
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ pad: "x".repeat(200) })}\n`);
    const warn = vi.fn();
    const sink = leaseEventSink(dir, { now: () => TS, maxBytes: 100, warn });
    sink(RELEASE);
    sink({ type: "reap", id: "9-zz", reason: "corrupt" });
    expect(lines().slice(1)).toEqual([
      { ts: ISO, ...RELEASE },
      { ts: ISO, type: "reap", id: "9-zz", reason: "corrupt" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("creates events.jsonl with mode 0600", () => {
    leaseEventSink(dir)(RELEASE);
    expect(statSync(join(dir, "events.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("rotates past 5 MiB by default, not at it", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, "");
    truncateSync(file, 5 * 1024 * 1024);
    const sink = leaseEventSink(dir);
    sink(RELEASE);
    expect(existsSync(`${file}.1`)).toBe(false);
    sink(RELEASE);
    expect(statSync(`${file}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("does not follow a symlink planted at events.jsonl", () => {
    writeFileSync(join(tmp, "victim"), "untouched\n");
    symlinkSync(join(tmp, "victim"), join(dir, "events.jsonl"));
    leaseEventSink(dir)(RELEASE);
    expect(readFileSync(join(tmp, "victim"), "utf8")).toBe("untouched\n");
  });

  it.skipIf(noFifos)("writes nothing into a FIFO planted at events.jsonl", () => {
    execFileSync("mkfifo", [join(dir, "events.jsonl")]);
    const reader = openSync(join(dir, "events.jsonl"), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      leaseEventSink(dir)(RELEASE);
      let read = 0;
      try {
        read = readSync(reader, Buffer.alloc(256));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      }
      expect(read).toBe(0);
    } finally {
      closeSync(reader);
    }
  });

  it.each<[string, () => string]>([
    ["a symlink", () => (symlinkSync(dir, join(tmp, "link")), join(tmp, "link"))],
    ["another user's", () => (vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValue(statSync(dir).uid + 1), dir)],
  ])("writes nothing when the lease directory is %s, and the acquire still proceeds", (_name, plant) => {
    const leaseDir = plant();
    const h = tryAcquireLease({ ...defaultLeaseOptions({ CO_LEASE_DIR: leaseDir }), level: normal, warn: () => {} }, { command: "npm test", cwd: "/w" });
    expect(h).toMatchObject({ leased: false, id: null });
    expect(readdirSync(dir)).toEqual([]);
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

    it.skipIf(noFifos)("a FIFO planted at events.jsonl, with no reader, never blocks an acquire", async () => {
      execFileSync("mkfifo", [join(dir, "events.jsonl")]);
      let h: ReturnType<typeof tryAcquireLease> = null;
      const ms = await timedBesideFifo(join(dir, "events.jsonl"), () => {
        h = tryAcquireLease({ ...defaultLeaseOptions({ CO_LEASE_DIR: dir }), level: normal }, { command: "npm test", cwd: "/w" });
      });
      expect(ms).toBeLessThan(1000);
      expect(h).toMatchObject({ leased: true });
      h!.release();
    });

    it("is exported from the barrel", () => {
      expect(barrel.leaseEventSink).toBe(leaseEventSink);
    });
  });
});
