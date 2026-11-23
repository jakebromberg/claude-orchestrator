import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseHeavyQueueArgs } from "../src/cli-heavy-queue.js";
import { renderQueue, runWatch, type WatchDeps } from "../src/heavy-queue-watch.js";
import type { StatusView } from "../src/lease-run.js";

const GB = 1024 ** 3;
const NOW = new Date("2026-11-23T16:52:13Z");

const busy: StatusView = {
  level: "warning",
  capacity: 2,
  live: [
    { pid: 77875, command: "2855: sweep", ageSec: 38, priority: "high" },
    { pid: 80001, command: "samplefit: corpus", ageSec: 3725, suspended: true },
  ],
  waiting: [
    { seq: 48, label: "2858: build tests", gated: true, ready: false, priority: "high" },
    { seq: 39, label: "samplefit:csmd-loadtest", gated: true, ready: true },
    { seq: 52, label: "hook call", gated: false },
  ],
  weights: { used: 4.5 * GB, budget: 2.875 * GB, free: { freeBytes: 8.875 * GB, reserve: 6 * GB, settled: 0 } },
  unowned: { simulators: 0, claude: 2.5 * GB, others: [{ pid: 24254, command: "/System/Library/Foo.xpc/Contents/MacOS/PerfPowerServicesSignpostReader", bytes: 0.75 * GB }] },
};

describe("parseHeavyQueueArgs watch", () => {
  it.each<[string, string[], unknown]>([
    ["watch", ["watch"], { kind: "watch", intervalSec: 2 }],
    ["watch --interval 5", ["watch", "--interval", "5"], { kind: "watch", intervalSec: 5 }],
    ["watch --interval 0.5", ["watch", "--interval", "0.5"], { kind: "watch", intervalSec: 0.5 }],
  ])("parses %s", (_name, argv, expected) => {
    expect(parseHeavyQueueArgs(argv)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["a zero interval", ["watch", "--interval", "0"]],
    ["a negative interval", ["watch", "--interval", "-1"]],
    ["a non-numeric interval", ["watch", "--interval", "soon"]],
    ["a missing interval", ["watch", "--interval"]],
    ["an extra argument", ["watch", "extra"]],
  ])("rejects %s", (_name, argv) => {
    expect(parseHeavyQueueArgs(argv)).toBeUndefined();
  });
});

describe("renderQueue", () => {
  const lines = (view: StatusView | Error, width = 200) => renderQueue(view, { now: NOW, width, timeZone: "America/Los_Angeles" }).split("\n");

  it("heads the frame with the local time, level, capacity and memory budget", () => {
    expect(lines(busy)[0]).toBe("heavy queue  08:52:13 PST  level warning  capacity 2  memory 4.5 GB / 2.9 GB budget (free 8.9 GB, reserve 6.0 GB)");
  });

  it("lists the running holders with pid, age, priority and state", () => {
    const out = lines(busy);
    const at = out.indexOf("RUNNING (2)");
    expect(at).toBeGreaterThan(0);
    expect(out.slice(at + 1, at + 4)).toEqual([
      "  PID    AGE      PRI     STATE      COMMAND",
      "  77875  0:38     high    running    2855: sweep",
      "  80001  1:02:05  normal  SUSPENDED  samplefit: corpus",
    ]);
  });

  it("lists the waiting tickets in the order given, numbered, with readiness", () => {
    const out = lines(busy);
    const at = out.indexOf("WAITING (3)");
    expect(out.slice(at + 1, at + 5)).toEqual([
      "  #  SEQ  PRI     GATE     LABEL",
      "  1  48   high    blocked  2858: build tests",
      "  2  39   normal  ready    samplefit:csmd-loadtest",
      "  3  52   normal  ungated  hook call",
    ]);
  });

  it("names the memory the lease does not own, with the process's base name", () => {
    expect(lines(busy).at(-1)).toBe("UNOWNED  claude 2.5 GB  simulators 0.0 GB  PerfPowerServicesSignpostReader (24254) 0.8 GB");
  });

  it("says so when nothing runs or waits, and leaves out absent weights and unowned memory", () => {
    const out = lines({ level: "normal", capacity: 4, live: [] });
    expect(out).toEqual(["heavy queue  08:52:13 PST  level normal  capacity 4", "", "RUNNING (0)", "  nothing running", "", "WAITING (0)", "  nothing waiting"]);
  });

  it("shows a status read error in place of the tables", () => {
    expect(lines(new Error("CO_LEASE_DIR must be absolute"))).toEqual(["heavy queue  08:52:13 PST", "", "status unavailable: CO_LEASE_DIR must be absolute"]);
  });

  it("cuts every line to the terminal width", () => {
    for (const line of lines(busy, 30)) expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe("runWatch", () => {
  const rig = (over: Partial<WatchDeps> = {}) => {
    const written: string[] = [];
    const ticks: (() => void)[] = [];
    let cancelled = 0;
    const signals = new EventEmitter();
    let reads = 0;
    const deps: WatchDeps = {
      status: () => (reads++, busy),
      now: () => NOW,
      every: (fn) => (ticks.push(fn), () => void cancelled++),
      write: (t) => void written.push(t),
      isTTY: true,
      columns: () => 120,
      signals,
      timeZone: "America/Los_Angeles",
      ...over,
    };
    return { deps, written, ticks, signals, cancelled: () => cancelled, reads: () => reads };
  };

  it("draws a frame at once and again on every tick, in the alternate screen, and restores the screen on SIGINT", async () => {
    const r = rig();
    const done = runWatch({ intervalSec: 2 }, r.deps);
    expect(r.reads()).toBe(1);
    r.ticks[0]!();
    expect(r.reads()).toBe(2);
    r.signals.emit("SIGINT");
    await expect(done).resolves.toBe(0);
    expect(r.written[0]).toBe("\x1b[?1049h\x1b[?25l");
    expect(r.written[1]).toMatch(/^\x1b\[H.*heavy queue/s);
    expect(r.written[1]).toMatch(/\x1b\[J$/);
    expect(r.written.at(-1)).toBe("\x1b[?25h\x1b[?1049l");
    expect(r.cancelled()).toBe(1);
    expect(r.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("asks for the interval in milliseconds", async () => {
    let ms = 0;
    const r = rig({ every: (_fn, m) => ((ms = m), () => {}) });
    const done = runWatch({ intervalSec: 0.5 }, r.deps);
    r.signals.emit("SIGTERM");
    await done;
    expect(ms).toBe(500);
  });

  it("keeps drawing when a status read throws", async () => {
    let n = 0;
    const r = rig({ status: () => { if (n++ === 0) throw new Error("boom"); return busy; } });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.ticks[0]!();
    r.signals.emit("SIGINT");
    await done;
    expect(r.written[1]).toContain("status unavailable: boom");
    expect(r.written[2]).toContain("RUNNING (2)");
  });

  it("writes plain frames with no escape codes when the output is not a terminal", async () => {
    const r = rig({ isTTY: false });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.signals.emit("SIGINT");
    await done;
    expect(r.written.join("")).not.toContain("\x1b");
    expect(r.written[0]).toMatch(/^heavy queue.*\n\n$/s);
  });
});
