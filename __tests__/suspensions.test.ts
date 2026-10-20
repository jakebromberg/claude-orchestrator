import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSuspensionArgs, runSuspension, type SuspensionDeps } from "../src/suspensions.js";
import { ps } from "../src/ps.js";
import { psText } from "./helpers/ps-text.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
// The caller is pid 500 under parents 400 and 300. None of them leads its own group (groups 450, 350, 300 is led
// by zsh), so a check that compared the target with their pids instead of their pgids would fail the refusal rows.
const TABLE: [number, number, number, number, string][] = [
  [500, 400, 450, 501, "node cli-lease.js suspend"],
  [400, 300, 350, 501, "claude"],
  [300, 1, 300, 501, "zsh"],
  [900, 1, 900, 501, "sleep 100"],
  [901, 900, 900, 501, "sleep 101"],
  [800, 1, 800, 501, "mine-leader"],
  [801, 800, 800, 0, "root-member"],
  [911, 1, 910, 501, "orphan-member"],
];
const table = (rows = TABLE) => psText(rows.map(([pid, ppid, pgid, uid, command]) => ({ pid, ppid, pgid, uid, command })));

describe("suspend and resume", () => {
  let dir: string;
  let kills: [number, string][];
  let out: string[];
  let err: string[];
  let atKill: () => void;
  const file = (pgid: number) => join(dir, "suspensions", `${pgid}.json`);
  const records = () => (existsSync(join(dir, "suspensions")) ? readdirSync(join(dir, "suspensions")) : []);
  const deps = (over: Partial<SuspensionDeps> = {}): SuspensionDeps => ({
    dir,
    ps: () => table(),
    kill: (pid, signal) => {
      atKill();
      kills.push([pid, signal]);
    },
    now: () => NOW,
    pid: 500,
    uid: 501,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  });
  const run = (argv: string[], over?: Partial<SuspensionDeps>) => runSuspension(argv, deps(over));
  const suspend = (pgid: string | number, ...rest: string[]) => ["suspend", String(pgid), "--by", "owner", "--reason", "testing", ...rest];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-suspensions-"));
    kills = [];
    out = [];
    err = [];
    atKill = () => {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("refusals", () => {
    const targets: [string, string, string][] = [
      ["pid 0", "0", "not a process group"],
      ["pid 1", "1", "not a process group"],
      ["a non-pid", "abc", "not a process group"],
      ["a pid past 2^31", "2147483648", "not a process group"],
      ["the caller's own group", "450", "own or an ancestor's"],
      ["a parent's group", "350", "own or an ancestor's"],
      ["a further ancestor's group", "300", "own or an ancestor's"],
      ["a group with a member owned by another user", "800", "another user"],
    ];
    const verbs: [string, string[]][] = [
      ["suspend", ["--by", "owner", "--reason", "testing"]],
      ["resume", []],
    ];
    it.each(verbs.flatMap(([verb, rest]) => targets.map(([name, pgid, message]) => ({ verb, rest, name, pgid, message }))))(
      "$verb refuses $name",
      ({ verb, rest, pgid, message }) => {
        expect(run([verb, pgid, ...rest])).toBe(1);
        expect(err.join("\n")).toContain(message);
        expect(kills).toEqual([]);
        expect(records()).toEqual([]);
      },
    );

    it.each([[[]], [["--record-only"]]])("suspend %j refuses a group with no live members", (extra) => {
      expect(run(suspend(9999, ...extra))).toBe(1);
      expect(err.join("\n")).toContain("no live members");
      expect(kills).toEqual([]);
      expect(records()).toEqual([]);
    });

    it("suspend refuses a group that already has a record, leaving the record alone", () => {
      expect(run(suspend(900, "--record-only"))).toBe(0);
      const before = readFileSync(file(900), "utf-8");
      expect(run(["suspend", "900", "--by", "someone", "--reason", "else"])).toBe(1);
      expect(err.join("\n")).toContain("already has a suspension record");
      expect(readFileSync(file(900), "utf-8")).toBe(before);
      expect(kills).toEqual([]);
    });

    it.each(["symlink", "file"])("suspend and resume refuse a suspensions/ that is a %s and touch nothing through it", (kind) => {
      const elsewhere = mkdtempSync(join(tmpdir(), "co-suspensions-elsewhere-"));
      writeFileSync(join(elsewhere, "900.json"), "keep");
      if (kind === "symlink") symlinkSync(elsewhere, join(dir, "suspensions"));
      else writeFileSync(join(dir, "suspensions"), "not a directory");
      try {
        expect(run(suspend(900))).toBe(1);
        expect(run(["resume", "900"])).toBe(1);
        expect(kills).toEqual([]);
        expect(readdirSync(elsewhere)).toEqual(["900.json"]);
        expect(readFileSync(join(elsewhere, "900.json"), "utf-8")).toBe("keep");
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it.each(["suspend", "resume"])("%s refuses when the table cannot show the caller's whole ancestry (fails closed)", (verb) => {
      const gap = TABLE.filter(([pid]) => pid !== 400);
      expect(run([verb, "900", ...(verb === "suspend" ? ["--by", "o", "--reason", "r"] : [])], { ps: () => table(gap) })).toBe(1);
      expect(err.join("\n")).toContain("ancestry");
      expect(kills).toEqual([]);
      expect(records()).toEqual([]);
    });

    it.each(["suspend", "resume"])("%s refuses when the ancestry never reaches pid 1 within 64 steps", (verb) => {
      // 300's parent is 500 again: a chain that loops is cut off by the step cap, and the cap refuses, never passes.
      const loop = TABLE.map((r): (typeof TABLE)[number] => (r[0] === 300 ? [300, 500, 300, 501, "zsh"] : r));
      expect(run([verb, "900", ...(verb === "suspend" ? ["--by", "o", "--reason", "r"] : [])], { ps: () => table(loop) })).toBe(1);
      expect(err.join("\n")).toContain("ancestry");
      expect(kills).toEqual([]);
      expect(records()).toEqual([]);
    });

    it("refuses when the process table cannot be read", () => {
      const broken = () => {
        throw new Error("ps timed out");
      };
      expect(run(suspend(900), { ps: broken })).toBe(1);
      expect(kills).toEqual([]);
    });
  });

  describe("usage errors", () => {
    it.each([
      ["no pgid", ["suspend", "--by", "o", "--reason", "r"]],
      ["two pgids", ["suspend", "900", "901", "--by", "o", "--reason", "r"]],
      ["no --by", ["suspend", "900", "--reason", "r"]],
      ["no --reason", ["suspend", "900", "--by", "o"]],
      ["a flag without its value", ["suspend", "900", "--by", "o", "--reason"]],
      ["an unknown flag", ["suspend", "900", "--by", "o", "--reason", "r", "--force"]],
      ["resume with no pgid", ["resume"]],
      ["resume with suspend's flags", ["resume", "900", "--by", "o"]],
      ...["0m", "2d", "1.5h", "h", "-1h", "2", "02h", "2 h", "721h", "43201m", "99999999999h"].map((v): [string, string[]] => [`--remind ${JSON.stringify(v)}`, suspend(900, "--remind", v)]),
    ])("exits 64 for %s", (_name, argv) => {
      expect(run(argv)).toBe(64);
      expect(err.join("\n")).toContain("usage:");
      expect(kills).toEqual([]);
      expect(records()).toEqual([]);
    });

    it.each([
      ["90m", 90 * 60_000],
      ["2h", 2 * 3_600_000],
      ["1m", 60_000],
      ["720h", 720 * 3_600_000],
      [undefined, 2 * 3_600_000],
    ])("parses --remind %s", (value, ms) => {
      const parsed = parseSuspensionArgs(suspend(900, ...(value ? ["--remind", value] : [])));
      expect(parsed).toMatchObject({ kind: "suspend", pgid: 900, remindMs: ms });
    });
  });

  describe("records", () => {
    const read = (pgid: number) => JSON.parse(readFileSync(file(pgid), "utf-8"));

    it.each([
      ["the default reminder is 2 hours", [], "2026-10-16T14:00:00.000Z"],
      ["--remind 90m", ["--remind", "90m"], "2026-10-16T13:30:00.000Z"],
      ["--remind 3h", ["--remind", "3h"], "2026-10-16T15:00:00.000Z"],
    ])("writes the record: %s", (_name, extra, remindAt) => {
      expect(run(suspend(900, ...extra))).toBe(0);
      expect(read(900)).toEqual({ pgid: 900, by: "owner", reason: "testing", at: "2026-10-16T12:00:00.000Z", remindAt, leader: "sleep 100" });
      expect(lstatSync(file(900)).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(dir, "suspensions")).mode & 0o777).toBe(0o700);
    });

    it("records leader null when the group's leader has exited", () => {
      expect(run(suspend(910))).toBe(0);
      expect(read(910).leader).toBeNull();
      expect(kills).toEqual([[-910, "SIGSTOP"]]);
    });

    it("writes the record before SIGSTOP, and signals the whole group", () => {
      let existedAtSignal = false;
      atKill = () => (existedAtSignal = existsSync(file(900)));
      expect(run(suspend(900))).toBe(0);
      expect(existedAtSignal).toBe(true);
      expect(kills).toEqual([[-900, "SIGSTOP"]]);
    });

    it("--record-only writes the record and sends no signal", () => {
      expect(run(suspend(900, "--record-only"))).toBe(0);
      expect(read(900).pgid).toBe(900);
      expect(kills).toEqual([]);
    });

    it("removes the record again when SIGSTOP fails", () => {
      const denied = () => {
        throw new Error("EPERM");
      };
      expect(run(suspend(900), { kill: denied })).toBe(1);
      expect(records()).toEqual([]);
    });

    it("exits 1 with the kill ESRCH message and removes the record when the group vanishes before SIGSTOP", () => {
      const gone = () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      };
      expect(run(suspend(900), { kill: gone })).toBe(1);
      expect(err.join("\n")).toContain("kill ESRCH");
      expect(records()).toEqual([]);
    });

    it("resume sends SIGCONT before removing the record", () => {
      run(suspend(900, "--record-only"));
      let existedAtSignal = false;
      atKill = () => (existedAtSignal = existsSync(file(900)));
      expect(run(["resume", "900"])).toBe(0);
      expect(existedAtSignal).toBe(true);
      expect(kills).toEqual([[-900, "SIGCONT"]]);
      expect(records()).toEqual([]);
    });

    it("resume without a record still sends SIGCONT and says so", () => {
      expect(run(["resume", "900"])).toBe(0);
      expect(kills).toEqual([[-900, "SIGCONT"]]);
      expect(out.join("\n")).toContain("no record existed");
    });

    it.each([
      ["ESRCH", 0, []],
      ["EPERM", 1, ["900.json"]],
    ])("resume when SIGCONT fails with %s exits %i and leaves records %j", (code, exit, left) => {
      run(suspend(900, "--record-only"));
      const fail = () => {
        throw Object.assign(new Error(code), { code });
      };
      expect(run(["resume", "900"], { kill: fail })).toBe(exit);
      expect(records()).toEqual(left);
    });
  });

  describe("with real processes", () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const c of children.splice(0)) {
        try {
          process.kill(-(c.pid as number), "SIGKILL");
        } catch {}
      }
    });
    const state = (pid: number) => execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const real = (): SuspensionDeps => ({
      dir,
      ps,
      kill: (pid, signal) => void process.kill(pid, signal),
      now: () => NOW,
      pid: process.pid,
      uid: process.getuid?.(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    it("stops a spawned sleep group, then continues it", () => {
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      children.push(child);
      const pid = child.pid as number;
      expect(runSuspension(suspend(pid), real())).toBe(0);
      expect(state(pid)).toMatch(/^T/);
      expect(JSON.parse(readFileSync(file(pid), "utf-8")).pgid).toBe(pid);
      expect(runSuspension(["resume", String(pid)], real())).toBe(0);
      expect(state(pid)).not.toMatch(/^T/);
      expect(records()).toEqual([]);
    });
  });
});
