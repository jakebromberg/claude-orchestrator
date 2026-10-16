import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFRESH_MS } from "../src/engine-registry.js";
import { runWatchdog, type WatchdogDeps } from "../src/watchdog.js";

const T0 = Date.parse("2026-10-16T12:00:00Z");
const MIN = 60_000;

type Row = [pid: number, ppid: number, pgid: number, stat: string, command: string];
const table = (rows: Row[]) => rows.map(([pid, ppid, pgid, stat, command]) => `${pid} ${ppid} ${pgid} 501 ${stat} 01:00 ${command}`).join("\n");

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
      writeRecord("suspensions", "100.json", { pgid: 100, by: "owner" });
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
      engine({}, 3 * REFRESH_MS);
      checkAt(0);
      expect(brief()).toBe("");
      engine({}, 3 * REFRESH_MS + 1);
      checkAt(1);
      expect(brief()).toContain("died");
    });

    it("reports a stale record with a live pid as a stopped group, not dead", () => {
      rows = stoppedEngine;
      engine({}, 5 * MIN);
      checkAt(0);
      expect(brief()).toBe("");
      checkAt(6);
      expect(brief()).toContain("process group 700");
      expect(brief()).not.toContain("died");
    });

    // Sessions share the engine's group (spawned without detached), so a stale record with a live pid is reported on
    // its own, whatever the group's stat says: a pid-only stop, or an engine wedged while still running.
    it.each([
      ["stopped by pid while its session in the same group runs", [[700, 1, 700, "T", "node run.js"], [701, 700, 700, "S", "claude -p"]] as Row[]],
      ["running but wedged", [[700, 1, 700, "S", "node run.js"]] as Row[]],
    ])("reports a stale record with a live pid when the engine is %s", (_name, scan) => {
      rows = scan;
      engine({}, 4 * MIN);
      checkAt(0);
      expect(brief()).toBe("");
      engine({}, 6 * MIN);
      checkAt(0);
      expect(brief()).toContain("engine run-1 (pid 700)");
      expect(brief()).toContain("stopped or wedged");
      expect(brief()).not.toContain("died");
      expect(brief()).not.toContain("process group 700");
    });

    it("reports a whole stopped engine group once, by group, not again as a wedged engine", () => {
      rows = stoppedEngine;
      engine({}, 10 * MIN);
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
      writeRecord("suspensions", "700.json", { pgid: 700 });
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
      scanError = new Error("spawnSync ps ETIMEDOUT");
      expect(checkAt(10)).toBe(0);
      expect(readFileSync(join(dir, "watchdog.json"), "utf-8")).toBe(before);
      expect(log()).toContain("scan skipped: spawnSync ps ETIMEDOUT");
      scanError = undefined;
      checkAt(11);
      expect(brief()).toContain("process group 100");
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
});
