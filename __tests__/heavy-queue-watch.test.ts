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
    ["the shortest interval, 0.1", ["watch", "--interval", "0.1"], { kind: "watch", intervalSec: 0.1 }],
    ["the longest interval a timer holds", ["watch", "--interval", "2147483"], { kind: "watch", intervalSec: 2147483 }],
  ])("parses %s", (_name, argv, expected) => {
    expect(parseHeavyQueueArgs(argv)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["a zero interval", ["watch", "--interval", "0"]],
    ["an interval under 0.1 s, which would spin", ["watch", "--interval", "0.0001"]],
    ["an interval past a timer's range, which Node turns into 1 ms", ["watch", "--interval", "3000000"]],
    ["a negative interval", ["watch", "--interval", "-1"]],
    ["a non-numeric interval", ["watch", "--interval", "soon"]],
    ["a missing interval", ["watch", "--interval"]],
    ["an extra argument", ["watch", "extra"]],
  ])("rejects %s", (_name, argv) => {
    expect(parseHeavyQueueArgs(argv)).toBeUndefined();
  });
});

describe("renderQueue", () => {
  const lines = (view: StatusView | Error, width = 200, more: { height?: number; notes?: string[] } = {}) =>
    renderQueue(view, { now: NOW, width, timeZone: "America/Los_Angeles", ...more }).split("\n");

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

  it.each<[string, string, string]>([
    ["a bare path", "/usr/libexec/foo", "foo"],
    ["a program with an argument path", "java -jar /opt/svc/app.jar --data /var/cache", "java"],
    ["a program with a script", "node /Users/x/proj/server.js", "node"],
    ["a path with spaces and flags", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer", "Google Chrome Helper"],
  ])("names an unowned process by its program for %s", (_name, command, name) => {
    const view: StatusView = { level: "normal", capacity: 1, live: [], unowned: { simulators: 0, claude: 0, others: [{ pid: 7, command, bytes: GB }] } };
    expect(lines(view).at(-1)).toBe(`UNOWNED  claude 0.0 GB  simulators 0.0 GB  ${name} (7) 1.0 GB`);
  });

  it("shows a gated ticket with no recorded readiness, from an older build, as unknown", () => {
    const out = lines({ level: "normal", capacity: 1, live: [], waiting: [{ seq: 4, label: "old", gated: true }] });
    expect(out).toContain("  1  4    normal  unknown  old");
  });

  it("puts control characters in a command or label on one line as spaces", () => {
    const out = lines({ level: "normal", capacity: 1, live: [{ pid: 1, command: "make a\nmake b\x1b[31m", ageSec: 0 }], waiting: [{ seq: 2, label: "x\ty", gated: false }] });
    expect(out).toContain("  1    0:00  normal  running  make a make b [31m");
    expect(out).toContain("  1  2    normal  ungated  x y");
    expect(out.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  it("cuts a frame taller than the screen to its height and says how many lines are hidden", () => {
    const out = lines(busy, 200, { height: 8 });
    expect(out).toHaveLength(8);
    expect(out[0]).toMatch(/^heavy queue/);
    expect(out.at(-1)).toBe("… 7 more lines");
  });

  it("leaves a frame that fits its height whole", () => {
    expect(lines(busy, 200, { height: 100 })).toEqual(lines(busy));
  });

  it("shows each lease warning under the header", () => {
    const out = lines({ level: "normal", capacity: 4, live: [] }, 200, { notes: ["lease: ignoring invalid CO_LEASE_SLOTS=\"abc\""] });
    expect(out.slice(0, 3)).toEqual(["heavy queue  08:52:13 PST  level normal  capacity 4", "! lease: ignoring invalid CO_LEASE_SLOTS=\"abc\"", ""]);
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
    const stops: (() => void)[] = [];
    let unsubscribed = 0;
    let reads = 0;
    const deps: WatchDeps = {
      status: () => (reads++, busy),
      now: () => NOW,
      every: (fn) => (ticks.push(fn), () => void cancelled++),
      write: (t) => void written.push(t),
      isTTY: true,
      columns: () => 120,
      rows: () => 40,
      notes: () => [],
      onStop: (fn) => (stops.push(fn), () => void unsubscribed++),
      timeZone: "America/Los_Angeles",
      ...over,
    };
    const stop = () => stops[0]!();
    return { deps, written, ticks, stop, cancelled: () => cancelled, unsubscribed: () => unsubscribed, reads: () => reads };
  };

  it("draws a frame at once and again on every tick, in the alternate screen, and restores the screen when stopped", async () => {
    const r = rig();
    const done = runWatch({ intervalSec: 2 }, r.deps);
    expect(r.reads()).toBe(1);
    r.ticks[0]!();
    expect(r.reads()).toBe(2);
    r.stop();
    await expect(done).resolves.toBe(0);
    expect(r.written[0]).toBe("\x1b[?1049h\x1b[?25l");
    expect(r.written[1]).toMatch(/^\x1b\[H.*heavy queue/s);
    expect(r.written[1]).toMatch(/\x1b\[J$/);
    expect(r.written.at(-1)).toBe("\x1b[?25h\x1b[?1049l");
    expect(r.cancelled()).toBe(1);
    expect(r.unsubscribed()).toBe(1);
  });

  it("cuts a terminal frame one column short of the width and to the screen's rows", async () => {
    const r = rig({ columns: () => 30, rows: () => 6 });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.stop();
    await done;
    const frame = r.written[1]!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
    expect(frame).toHaveLength(6);
    for (const line of frame) expect(line.length).toBeLessThanOrEqual(29);
  });

  it("draws the warnings collected so far in each frame", async () => {
    const r = rig({ notes: () => ["lease: something odd"] });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.stop();
    await done;
    expect(r.written[1]).toContain("! lease: something odd");
  });

  it("asks for the interval in milliseconds", async () => {
    let ms = 0;
    const r = rig({ every: (_fn, m) => ((ms = m), () => {}) });
    const done = runWatch({ intervalSec: 0.5 }, r.deps);
    r.stop();
    await done;
    expect(ms).toBe(500);
  });

  it("keeps drawing when a status read throws", async () => {
    let n = 0;
    const r = rig({ status: () => { if (n++ === 0) throw new Error("boom"); return busy; } });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.ticks[0]!();
    r.stop();
    await done;
    expect(r.written[1]).toContain("status unavailable: boom");
    expect(r.written[2]).toContain("RUNNING (2)");
  });

  it("writes whole plain frames with no escape codes, cut to no width or height, when the output is not a terminal", async () => {
    const long: StatusView = { level: "normal", capacity: 1, live: [{ pid: 1, command: "x".repeat(300), ageSec: 0 }] };
    const r = rig({ isTTY: false, columns: () => 30, rows: () => 3, status: () => long });
    const done = runWatch({ intervalSec: 2 }, r.deps);
    r.stop();
    await done;
    expect(r.written.join("")).not.toContain("\x1b");
    expect(r.written[0]).toMatch(/^heavy queue.*\n\n$/s);
    expect(r.written[0]).toContain("x".repeat(300));
  });
});
