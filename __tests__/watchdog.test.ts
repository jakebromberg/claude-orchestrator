import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFRESH_MS } from "../src/engine-registry.js";
import { runWatchdog, type WatchdogDeps } from "../src/watchdog.js";
import { psText } from "./helpers/ps-text.js";

const T0 = Date.parse("2026-10-16T12:00:00Z");
const MIN = 60_000;
const suspension = (pgid: number) => ({ pgid, by: "owner", reason: "r", at: "2026-10-16T12:00:00.000Z", remindAt: "2026-10-16T14:00:00.000Z", leader: null });

// `etime` defaults to two hours, so a row's process started before every engine record's `startedAt` (11:00).
type Row = [pid: number, ppid: number, pgid: number, stat: string, command: string, etime?: string];
const table = (rows: Row[]) => psText(rows.map(([pid, ppid, pgid, stat, command, etime]) => ({ pid, ppid, pgid, stat, command, etime })));

// A stopped session: claude leads group 100 and its child shares it.
const SESSION: Row[] = [
  [50, 1, 50, "S", "zsh"],
  [100, 50, 100, "T", "claude -p"],
  [101, 100, 100, "T", "node worker.js"],
];

describe("watchdog", () => {
  let dir: string;
  let now: number;
  let rows: Row[];
  let scanError: Error | undefined;
  let out: string[];
  const deps = (over: Partial<WatchdogDeps> = {}): WatchdogDeps => ({
    dir,
    scan: () => {
      if (scanError) throw scanError;
      return table(rows);
    },
    now: () => now,
    out: (line) => out.push(line),
    err: (line) => out.push(`ERR ${line}`),
    statfs: () => ({ bavail: 500, blocks: 1000 }),
    ...over,
  });
  const check = (over?: Partial<WatchdogDeps>) => runWatchdog(["check"], deps(over));
  const brief = () => readFileSync(join(dir, "watchdog.brief"), "utf-8");
  const log = () => readFileSync(join(dir, "watchdog.log"), "utf-8");
  const checkAt = (minutes: number, over?: Partial<WatchdogDeps>) => {
    now = T0 + minutes * MIN;
    return check(over);
  };
  const writeRecord = (sub: string, name: string, record: object, ageMs = 0) => {
    mkdirSync(join(dir, sub), { recursive: true });
    const file = join(dir, sub, name);
    writeFileSync(file, JSON.stringify(record));
    utimesSync(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
  };
  const engine = (over: object = {}, ageMs = 0, pid = 700) =>
    writeRecord("engines", `${pid}.json`, { pid, pgid: pid, runId: "run-1", logDir: "/tmp/logs", stallTimeout: 1800, startedAt: "2026-10-16T11:00:00Z", ...over }, ageMs);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-watchdog-"));
    now = T0;
    rows = SESSION;
    scanError = undefined;
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("idle booted simulators", () => {
    const U1 = "0A1B2C3D-1111-4222-8333-444455556666";
    const U2 = "9F8E7D6C-1111-4222-8333-444455556666";
    const DEV = "/Users/x/Library/Developer/CoreSimulator/Devices";
    const RT = "/Library/Developer/CoreSimulator/Volumes/iOS_23A/Library/Developer/CoreSimulator/Runtimes/iOS 26.0.simruntime/Contents/Resources/RuntimeRoot";
    // A booted device: launchd_sim names its own Devices/<udid>/ bootstrap, its runtime processes sit below it.
    const booted = (udid: string, base: number): Row[] => [
      [base, 1, base, "S", `${RT}/sbin/launchd_sim ${DEV}/${udid}/data/var/run/launchd_bootstrap.plist`],
      [base + 1, base, base, "S", `${RT}/usr/libexec/backboardd`],
    ];
    const tool = (command: string): Row[] => [[900, 50, 900, "S", command]];
    const message = () => JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf-8")).findings.map((f: { message: string }) => f.message).filter((m: string) => m.startsWith("simulator "));

    it.each([
      ["one idle device", booted(U1, 200), 6, [U1]],
      ["two idle devices", [...booted(U1, 200), ...booted(U2, 300)], 6, [U1, U2]],
      ["idle under 5 minutes", booted(U1, 200), 4, []],
      ["a live xcodebuild", [...booted(U1, 200), ...tool("xcodebuild test -scheme X")], 6, []],
      ["a live xcrun simctl", [...booted(U1, 200), ...tool("/usr/bin/xcrun simctl list")], 6, []],
      ["a live xcodebuild under a spaced Xcode path", [...booted(U1, 200), ...tool("/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/xcodebuild test")], 6, []],
      ["no simulators", SESSION, 6, []],
    ] as [string, Row[], number, string[]][])("%s", (_name, scan, at, udids) => {
      rows = scan;
      checkAt(0);
      checkAt(at);
      expect(message().map((m: string) => m.split(" ")[1])).toEqual(udids);
    });

    it("totals the device's runtime rows, skips an unreadable rss, and suggests the shutdown", () => {
      const scan = () => psText([{ pid: 200, ppid: 1, pgid: 200, rss: 1048576, command: `${RT}/sbin/launchd_sim ${DEV}/${U1}/data/x` }, { pid: 201, ppid: 200, pgid: 200, rss: 1048576, command: `${RT}/usr/libexec/backboardd` }, { pid: 202, ppid: 201, pgid: 200, rss: "-", command: `${RT}/bin/x` }]);
      checkAt(0, { scan });
      checkAt(6, { scan });
      expect(message()[0]).toContain("holding 2.0 GB");
      expect(message()[0]).toContain(`xcrun simctl shutdown ${U1}`);
    });

    it("omits the total when no rss is readable, and reports once", () => {
      const scan = () => psText([{ pid: 200, ppid: 1, pgid: 200, rss: "-", command: `${RT}/sbin/launchd_sim ${DEV}/${U1}/data/x` }]);
      checkAt(0, { scan });
      checkAt(6, { scan });
      expect(message()[0]).not.toContain("NaN");
      expect(message()[0]).not.toContain("GB");
      checkAt(8, { scan });
      expect(message()).toEqual([]);
    });

    it("starts the clock again after a tool runs", () => {
      rows = booted(U1, 200);
      checkAt(0);
      rows = [...booted(U1, 200), ...tool("xcodebuild test")];
      checkAt(3);
      rows = booted(U1, 200);
      checkAt(4);
      checkAt(8);
      expect(message()).toEqual([]);
      checkAt(10);
      expect(message()).toHaveLength(1);
    });
  });

  describe("unrecorded stopped groups", () => {
    it("is quiet at 4 minutes after first seen and reports at 6", () => {
      expect(checkAt(0)).toBe(0);
      checkAt(4);
      expect(brief()).toBe("");
      checkAt(6);
      expect(brief()).toContain("process group 100");
      expect(brief()).toContain("6m");
      expect(JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf-8")).findings).toHaveLength(1);
      expect(log()).toContain("process group 100");
    });

    it("logs a standing report once, not on every cycle", () => {
      checkAt(0);
      checkAt(6);
      checkAt(8);
      expect(brief()).toContain("process group 100");
      expect(log().match(/process group 100/g)).toHaveLength(1);
    });

    it("starts the clock again after the group runs", () => {
      checkAt(0);
      rows = SESSION.map(([pid, ppid, pgid, , command]) => [pid, ppid, pgid, "S", command]);
      checkAt(3);
      rows = SESSION;
      checkAt(4);
      checkAt(8);
      expect(brief()).toBe("");
      checkAt(10);
      expect(brief()).toContain("process group 100");
    });

    it("skips a group with a suspension record", () => {
      writeRecord("suspensions", "100.json", suspension(100));
      checkAt(0);
      checkAt(30);
      expect(brief()).toBe("");
    });

    it("ignores a suspension record's writeFileAtomic temp file", () => {
      writeRecord("suspensions", "100.json.4242.ab12cd34.tmp", { pgid: 100 });
      checkAt(0);
      checkAt(6);
      expect(brief()).toContain("process group 100");
    });

    it("skips a group that is not stopped throughout", () => {
      rows = [[100, 50, 100, "T", "claude -p"], [101, 100, 100, "S", "node worker.js"]];
      checkAt(0);
      checkAt(30);
      expect(brief()).toBe("");
    });

    it("reports a stopped group that descends from a claude process", () => {
      rows = [[100, 50, 100, "S", "claude -p"], [200, 100, 200, "T", "sleep 9"], [201, 200, 200, "T", "sleep 9"]];
      checkAt(0);
      checkAt(6);
      expect(brief()).toContain("process group 200");
    });

    it("skips a stopped group outside every claude tree and registered engine", () => {
      rows = [[50, 1, 50, "S", "zsh"], [300, 50, 300, "T", "vim notes.md"]];
      checkAt(0);
      checkAt(30);
      expect(brief()).toBe("");
    });
  });

  describe("engine registry", () => {
    const stoppedEngine: Row[] = [[700, 1, 700, "T", "node run.js"]];

    it("reads no engines through a symlinked engines/", () => {
      engine({}, 2 * MIN);
      renameSync(join(dir, "engines"), join(dir, "real-engines"));
      symlinkSync(join(dir, "real-engines"), join(dir, "engines"));
      checkAt(0);
      expect(brief()).toBe("");
    });

    it("reports a stale record whose pid has no scan row once per runId and leaves the record", () => {
      engine({}, 2 * MIN);
      checkAt(0);
      expect(brief()).toContain("run-1");
      expect(brief()).toContain("died");
      checkAt(2);
      expect(brief()).toBe("");
      expect(log().match(/run-1/g)).toHaveLength(1);
      expect(existsSync(join(dir, "engines", "700.json"))).toBe(true);
    });

    it("reports a second dead engine with another runId", () => {
      engine({}, 2 * MIN);
      checkAt(0);
      engine({ runId: "run-2" }, 2 * MIN, 701);
      checkAt(1);
      expect(brief()).toContain("run-2");
      expect(brief()).not.toContain("run-1");
    });

    it("keeps a record fresh for three refresh periods", () => {
      engine({ startedAt: "2026-10-16T11:59:00Z" }, 3 * REFRESH_MS);
      checkAt(0);
      expect(brief()).toBe("");
      engine({}, 3 * REFRESH_MS + 1);
      checkAt(1);
      expect(brief()).toContain("died");
    });

    it("reports a stale record with a live pid as stopped, then by group, never as dead", () => {
      rows = stoppedEngine;
      // Its own stat is T and its record is 5 minutes stale: reported as an engine before the group rule's own 5 minutes pass.
      engine({}, 5 * MIN);
      checkAt(0);
      expect(brief()).toContain("stopped or wedged");
      expect(brief()).not.toContain("died");
      checkAt(6);
      expect(brief()).not.toContain("wedged");
      expect(brief()).toContain("process group 700");
      expect(brief()).not.toContain("died");
    });

    // Sessions share the engine's group (spawned without detached), so a stale record with a live pid is reported on
    // its own, whatever the group's stat says. An engine whose own stat is T is stopped and is reported on the
    // stopped-group bound; one that is running is reported only past its stallTimeout + 10 minutes (40 at 1800 s), so
    // a healthy engine blocked in a long synchronous command is not, and never at stallTimeout 0 (no silence check).
    it.each([
      ["stopped by pid while its session in the same group runs", [[700, 1, 700, "T", "node run.js"], [701, 700, 700, "S", "claude -p"]] as Row[], 4, 6],
      ["running but wedged", [[700, 1, 700, "S", "node run.js"]] as Row[], 39, 41],
    ])("reports a stale record with a live pid when the engine is %s", (_name, scan, quiet, loud) => {
      rows = scan;
      engine({}, quiet * MIN);
      checkAt(0);
      expect(brief()).toBe("");
      engine({}, loud * MIN);
      checkAt(0);
      expect(brief()).toContain("engine run-1 (pid 700)");
      expect(brief()).toContain("stopped or wedged");
      expect(brief()).not.toContain("died");
      expect(brief()).not.toContain("process group 700");
    });

    it.each([
      ["running, stallTimeout 600", "S", 600, 19, 21],
      ["stopped, stallTimeout 0", "T", 0, 4, 6],
      ["running, stallTimeout 0", "S", 0, 600, null],
    ])("times an engine that is %s from its own stat and stallTimeout", (_name, stat, stallTimeout, quiet, loud) => {
      rows = [[700, 1, 700, stat, "node run.js"], [701, 700, 700, "S", "claude -p"]];
      engine({ stallTimeout }, quiet * MIN);
      checkAt(0);
      expect(brief()).toBe("");
      if (loud === null) return;
      engine({ stallTimeout }, loud * MIN);
      checkAt(0);
      expect(brief()).toContain("stopped or wedged");
    });

    it("reports a stale record whose pid now belongs to a process started after the engine as dead, not wedged", () => {
      rows = [[700, 1, 700, "S", "vim notes", "05:00"]];
      engine({}, 60 * MIN);
      checkAt(0);
      expect(brief()).toContain("died");
      expect(brief()).not.toContain("wedged");
      checkAt(2);
      expect(brief()).toBe("");
    });

    it("keeps reporting a stalled engine while its group goes fully stopped, until the stopped-group rule reports it", () => {
      rows = [[700, 1, 700, "T", "node run.js"], [701, 700, 700, "S", "claude -p"]];
      engine({}, 41 * MIN);
      checkAt(0);
      expect(brief()).toContain("stopped or wedged");
      rows = [[700, 1, 700, "T", "node run.js"], [701, 700, 700, "T", "claude -p"]];
      // First seen fully stopped at minute 2, so the stopped-group rule reports it from minute 7.
      for (const m of [2, 4, 6]) {
        engine({}, (41 + m) * MIN);
        checkAt(m);
        expect(brief()).toContain("stopped or wedged");
      }
      engine({}, 48 * MIN);
      checkAt(7);
      expect(brief()).toContain("process group 700");
      expect(brief()).not.toContain("wedged");
    });

    it("skips a stalled engine whose group has a suspension record", () => {
      rows = [[700, 1, 700, "S", "node run.js"]];
      engine({}, 60 * MIN);
      writeRecord("suspensions", "700.json", suspension(700));
      checkAt(0);
      expect(brief()).toBe("");
    });

    it("reports a whole stopped engine group once, by group, not again as a wedged engine", () => {
      rows = stoppedEngine;
      engine({}, 50 * MIN);
      checkAt(0);
      checkAt(6);
      expect(brief()).toContain("process group 700");
      expect(brief()).not.toContain("wedged");
    });

    it("matches a record with pgid null through the scan", () => {
      rows = [[50, 1, 50, "S", "zsh"], [700, 50, 650, "T", "node run.js"]];
      engine({ pgid: null }, 5 * MIN);
      checkAt(0);
      checkAt(6);
      expect(brief()).toContain("process group 650");
    });

    it("skips a registered engine's group that has a suspension record", () => {
      rows = stoppedEngine;
      engine({}, 5 * MIN);
      writeRecord("suspensions", "700.json", suspension(700));
      checkAt(0);
      checkAt(30);
      expect(brief()).toBe("");
    });
  });

  describe("rules", () => {
    it("collects findings from every rule into one line", () => {
      engine({}, 2 * MIN);
      checkAt(0);
      checkAt(6);
      checkAt(7);
      expect(brief()).toMatch(/^watchdog: .*process group 100/);
      engine({ runId: "run-9" }, 2 * MIN, 701);
      checkAt(8);
      expect(brief()).toMatch(/^watchdog: .*process group 100.*; .*run-9/);
    });
  });

  describe("skipped cycles", () => {
    it("keeps the previous state and logs the skip when the scan throws", () => {
      checkAt(0);
      const before = readFileSync(join(dir, "watchdog.json"), "utf-8");
      scanError = new Error("spawnSync ps failed");
      expect(checkAt(10)).toBe(0);
      expect(readFileSync(join(dir, "watchdog.json"), "utf-8")).toBe(before);
      expect(log()).toContain("scan skipped: spawnSync ps failed");
      scanError = undefined;
      checkAt(11);
      expect(brief()).toContain("process group 100");
    });

    it("names the scan's bound when it times out", () => {
      scanError = Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
      checkAt(10);
      expect(log()).toContain("scan skipped: timed out at the 60 s bound");
    });

    it("skips an empty scan", () => {
      checkAt(0);
      expect(checkAt(10, { scan: () => "" })).toBe(0);
      expect(log()).toContain("scan skipped");
      checkAt(11);
      expect(brief()).toContain("process group 100");
    });
  });

  describe("the lease directory rule", () => {
    it("writes nothing when the directory is missing", () => {
      const missing = join(dir, "absent");
      expect(check({ dir: missing })).toBe(0);
      expect(existsSync(missing)).toBe(false);
    });

    it("writes nothing through a symlinked directory", () => {
      const link = join(tmpdir(), `co-watchdog-link-${process.pid}`);
      symlinkSync(dir, link);
      try {
        expect(check({ dir: link })).toBe(0);
        expect(existsSync(join(dir, "watchdog.json"))).toBe(false);
        expect(existsSync(join(dir, "watchdog.log"))).toBe(false);
      } finally {
        rmSync(link);
      }
    });

    it("appends nothing to a foreign-owned watchdog.log", () => {
      const file = join(dir, "watchdog.log");
      writeFileSync(file, "");
      const uid = statSync(dir).uid;
      // the first getuid call is check's directory test
      vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValueOnce(uid).mockReturnValue(uid + 1);
      scanError = new Error("no ps");
      check();
      vi.restoreAllMocks();
      expect(readFileSync(file, "utf-8")).toBe("");
    });

    it("does not follow a symlinked watchdog.log", () => {
      const target = join(dir, "elsewhere");
      writeFileSync(target, "");
      symlinkSync(target, join(dir, "watchdog.log"));
      checkAt(0);
      checkAt(6);
      expect(readFileSync(target, "utf-8")).toBe("");
    });
  });

  describe("brief", () => {
    it("prints the one-line summary", () => {
      checkAt(0);
      checkAt(6);
      expect(runWatchdog(["brief"], deps())).toBe(0);
      expect(out).toEqual([brief()]);
      expect(out[0]).toMatch(/^watchdog: .*process group 100/);
    });

    it("prints nothing when all is well, and when no check has run", () => {
      expect(runWatchdog(["brief"], deps())).toBe(0);
      checkAt(0);
      expect(runWatchdog(["brief"], deps())).toBe(0);
      expect(out).toEqual([]);
      expect(brief()).toBe("");
    });
  });

  describe("brief on a nearly full volume", () => {
    const free = (bavail: number) => ({ statfs: () => ({ bavail, blocks: 1000 }) });

    it("prints a disk-full line below the free fraction, writing no file", () => {
      expect(runWatchdog(["brief"], deps(free(5)))).toBe(0);
      expect(out).toEqual([expect.stringMatching(/nearly full \(0\.5% free\)/)]);
      expect(existsSync(join(dir, "watchdog.brief"))).toBe(false);
    });

    it("prints nothing at or above it", () => {
      runWatchdog(["brief"], deps(free(500)));
      expect(out).toEqual([]);
    });
  });

  it("rejects an unknown command with exit 64", () => {
    expect(runWatchdog(["stop"], deps())).toBe(64);
    expect(runWatchdog([], deps())).toBe(64);
    expect(out[0]).toContain("usage");
  });

  it("sends no signal: neither source file mentions one", () => {
    for (const file of ["../src/watchdog.ts", "../src/cli-watchdog.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf-8")).not.toMatch(/\bkill\b/i);
    }
  });

  describe("report rules", () => {
    const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
    const record = (over: object = {}) => ({ ...suspension(300), ...over });
    const OUTSIDE: Row[] = [[50, 1, 50, "S", "zsh"], [300, 50, 300, "T", "sleep 9"]];

    it.each([
      ["remindAt not yet due", OUTSIDE, record({ remindAt: iso(1) }), 0, false],
      ["due and stopped, outside every claude tree", OUTSIDE, record({ remindAt: iso(-1) }), 0, true],
      ["due but the group runs", [[300, 50, 300, "S", "sleep 9"]] as Row[], record({ remindAt: iso(-1) }), 0, false],
    ])("due reminder: %s", (_name, scan, rec, at, reported) => {
      rows = scan;
      writeRecord("suspensions", "300.json", rec);
      checkAt(at);
      expect(brief().includes("reminder due")).toBe(reported);
    });

    it("reports a due record with no live members once as stale and leaves it", () => {
      rows = [[50, 1, 50, "S", "zsh"]];
      writeRecord("suspensions", "300.json", record({ remindAt: iso(-1) }));
      checkAt(0);
      expect(brief()).toContain("no live members");
      checkAt(2);
      expect(brief()).toBe("");
      expect(existsSync(join(dir, "suspensions", "300.json"))).toBe(true);
    });

    it.each([
      ["29 minutes", "lease", 29, false],
      ["31 minutes", "lease", 31, true],
      ["31 minutes by the owner", "owner", 31, false],
    ])("lease suspension at %s", (_name, by, age, reported) => {
      rows = [[300, 50, 300, "S", "sleep 9"]];
      writeRecord("suspensions", "300.json", record({ by, at: iso(-age), remindAt: iso(600) }));
      checkAt(0);
      expect(brief().includes("suspended by the lease")).toBe(reported);
    });

    describe("silent engine", () => {
      const logs = () => join(dir, "logs");
      const logAge = (min: number) => {
        mkdirSync(logs(), { recursive: true });
        writeFileSync(join(logs(), "a.log"), "x");
        utimesSync(join(logs(), "a.log"), (T0 - min * MIN) / 1000, (T0 - min * MIN) / 1000);
      };
      beforeEach(() => {
        rows = [[700, 1, 700, "S", "node run.js"]];
      });

      it.each([
        ["logs newer than the threshold", 39, 1800, false],
        ["logs older than the threshold", 41, 1800, true],
        ["stallTimeout 0", 600, 0, false],
      ])("%s", (_name, age, stallTimeout, reported) => {
        engine({ logDir: logs(), stallTimeout });
        logAge(age);
        checkAt(0);
        expect(brief().includes("wrote no session log")).toBe(reported);
        expect(brief()).not.toContain("wedged");
      });

      it.each([
        ["a wait log written a minute ago", 1, false],
        ["a wait log older than the threshold", 41, true],
      ])("counts a session wait's progress line as activity: %s", (_name, age, reported) => {
        engine({ logDir: logs(), stallTimeout: 1800, startedAt: "2026-10-16T09:00:00Z" });
        mkdirSync(logs(), { recursive: true });
        writeFileSync(join(logs(), "issue-1.wait.log"), "x");
        utimesSync(join(logs(), "issue-1.wait.log"), (T0 - age * MIN) / 1000, (T0 - age * MIN) / 1000);
        checkAt(0);
        expect(brief().includes("wrote no session log")).toBe(reported);
      });

      it.each([
        ["within the threshold", "2026-10-16T11:30:00Z", false],
        ["past the threshold", "2026-10-16T11:10:00Z", true],
      ])("measures an engine with no logs from startedAt: %s", (_name, startedAt, reported) => {
        engine({ logDir: logs(), startedAt });
        checkAt(0);
        expect(brief().includes("wrote no session log")).toBe(reported);
      });
    });

    it.each([
      ["vim claude-notes", false],
      ["grep claude", false],
      ["/usr/local/bin/claude -p", true],
    ])("scope: a stopped %s is in scope only as the executable", (command, reported) => {
      rows = [[50, 1, 50, "S", "zsh"], [300, 50, 300, "T", command]];
      checkAt(0);
      checkAt(6);
      expect(brief().includes("process group 300")).toBe(reported);
    });
  });
});
