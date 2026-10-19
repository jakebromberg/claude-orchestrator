import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { ancestry, isPid, pidAlive, parseElapsed, parsePsTable, ps, psField, psAncestors, PS_TABLE_ARGS, type ProcRow } from "../src/ps.js";
import { psText } from "./helpers/ps-text.js";

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: vi.fn() }));

const exec = vi.mocked(execFileSync);
/** Makes each successive `ps` call print the next value; `Error` entries throw. */
const answers = (...values: (string | Error)[]) =>
  exec.mockImplementation((() => {
    const v = values.shift();
    if (v instanceof Error) throw v;
    return `${v}\n`;
  }) as unknown as typeof execFileSync);

describe("ps", () => {
  beforeEach(() => exec.mockReset());

  it("bounds every call at 2 s and discards stderr, with the timeout overridable", () => {
    answers("1", "2", "3");
    ps(["-o", "x="]);
    psField(7, "ppid");
    ps(["-ax"], { timeoutMs: 60_000 });
    expect(exec.mock.calls.map(([cmd, , o]) => [cmd, (o as { timeout: number }).timeout, (o as { stdio: unknown }).stdio])).toEqual([
      ["ps", 2_000, ["ignore", "pipe", "ignore"]],
      ["ps", 2_000, ["ignore", "pipe", "ignore"]],
      ["ps", 60_000, ["ignore", "pipe", "ignore"]],
    ]);
    expect(exec.mock.calls[1]![1]).toEqual(["-o", "ppid=", "-p", "7"]);
  });

  it("returns trimmed output and lets a failure propagate", () => {
    answers("  42  ", new Error("boom"));
    expect(psField(1, "pgid")).toBe("42");
    expect(() => psField(1, "pgid")).toThrow("boom");
  });

  it("walks parents nearest first, stopping at pid 1", () => {
    answers("20", "1");
    expect(psAncestors(10, 32)).toEqual([10, 20]);
  });

  it("stops at the depth bound", () => {
    answers("20", "30", "40");
    expect(psAncestors(10, 2)).toEqual([10, 20]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("ends the walk with what it found when a lookup fails", () => {
    answers("20", new Error("gone"));
    expect(psAncestors(10, 32)).toEqual([10, 20]);
    exec.mockReset();
    answers(new Error("gone"));
    expect(psAncestors(10, 32)).toEqual([10]);
  });
});

const MIN = 60_000;
const row = (pid: number, ppid: number, over: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid, pgid: pid, uid: 501, stat: "S", elapsedMs: 120 * MIN, command: `cmd${pid}`, ...over });

describe("PS_TABLE_ARGS", () => {
  it("asks for the seven columns parsePsTable reads, with no header", () => {
    expect(PS_TABLE_ARGS).toEqual(["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,command="]);
  });
});

describe("parsePsTable", () => {
  it.each<[string, string, ProcRow[]]>([
    ["a full row", psText([{ pid: 12, ppid: 3, pgid: 9, uid: 0, stat: "Ss", etime: "05:00", command: "node run.js" }]), [row(12, 3, { pgid: 9, uid: 0, stat: "Ss", elapsedMs: 5 * MIN, command: "node run.js" })]],
    ["a command with spaces", psText([{ pid: 5, ppid: 1, pgid: 5, command: "node  a.js --flag  'x y'" }]), [row(5, 1, { command: "node  a.js --flag  'x y'" })]],
    ["a stat with flags", psText([{ pid: 5, ppid: 1, pgid: 5, stat: "T+N<s", command: "vim" }]), [row(5, 1, { stat: "T+N<s", command: "vim" })]],
    ["padded columns", "  7   1   7 501 S 02:00:00 sleep 9", [row(7, 1, { command: "sleep 9" })]],
    ["a malformed line between good ones", `${psText([{ pid: 5, ppid: 1, pgid: 5, command: "a" }])}\nnot a row\n${psText([{ pid: 6, ppid: 1, pgid: 6, command: "b" }])}`, [row(5, 1, { command: "a" }), row(6, 1, { command: "b" })]],
    ["a row missing the command", "5 1 5 501 S 02:00:00", []],
    ["an empty table", "", []],
    ["an unreadable etime", psText([{ pid: 5, ppid: 1, pgid: 5, etime: "abc", command: "a" }]), [row(5, 1, { elapsedMs: NaN, command: "a" })]],
  ])("parses %s", (_name, text, rows) => {
    expect(parsePsTable(text)).toEqual(rows);
  });
});

describe("parseElapsed", () => {
  it.each([
    ["00:07", 7_000],
    ["05:00", 5 * MIN],
    ["02:00:00", 120 * MIN],
    ["1-00:00:00", 24 * 60 * MIN],
    ["3-02:03:04", ((3 * 24 + 2) * 60 + 3) * MIN + 4_000],
    ["", NaN],
    ["1-05:00", NaN],
    ["abc", NaN],
  ])("parses %j as %d ms", (etime, ms) => {
    expect(parseElapsed(etime)).toBe(ms);
  });
});

describe("ancestry", () => {
  const rows = [row(500, 400), row(400, 300), row(300, 1)];
  const loop = [row(500, 400), row(400, 300), row(300, 500)];
  const long = Array.from({ length: 70 }, (_, i) => row(i + 2, i + 3));
  it.each<[string, ProcRow[], number, number, number[], boolean]>([
    ["a complete chain, nearest first, without pid 1", rows, 500, 64, [500, 400, 300], true],
    ["a start that is pid 1", rows, 1, 64, [], true],
    ["a missing link", rows.filter((r) => r.pid !== 400), 500, 64, [500], false],
    ["a start with no row", rows, 999, 64, [], false],
    ["a loop", loop, 500, 64, Array.from({ length: 64 }, (_, i) => [500, 400, 300][i % 3]), false],
    ["the cap before pid 1", long, 2, 64, long.slice(0, 64).map((r) => r.pid), false],
    ["a chain exactly as long as the cap", rows, 500, 3, [500, 400, 300], true],
  ])("walks %s", (_name, table, pid, max, pids, complete) => {
    const walk = ancestry(table, pid, max);
    expect(walk.chain.map((r) => r.pid)).toEqual(pids);
    expect(walk.complete).toBe(complete);
  });
});

describe("isPid", () => {
  it.each([[1, true], [2 ** 31 - 1, true], [0, false], [-1, false], [2 ** 31, false], [1.5, false], ["7", false], [NaN, false]])("%j is %s", (n, ok) => {
    expect(isPid(n)).toBe(ok);
  });
});

describe("pidAlive", () => {
  const kill = (code?: string) =>
    vi.spyOn(process, "kill").mockImplementation((() => {
      if (code) throw Object.assign(new Error(code), { code });
      return true;
    }) as typeof process.kill);

  it.each([
    ["signal 0 succeeds", undefined, true],
    ["ESRCH", "ESRCH", false],
    ["EPERM (another user's process)", "EPERM", true],
  ])("%s", (_name, code, expected) => {
    const spy = kill(code);
    expect(pidAlive(4242)).toBe(expected);
    expect(spy).toHaveBeenCalledWith(4242, 0);
    spy.mockRestore();
  });

  it("finds this process alive and a reaped child dead", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.pid).toBeGreaterThan(0);
    expect(pidAlive(child.pid)).toBe(false);
  });
});
