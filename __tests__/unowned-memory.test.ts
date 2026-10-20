import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleUnowned, summarizeUnowned, UNOWNED_PS_ARGS, UNOWNED_CACHE_MS } from "../src/unowned-memory.js";

const MB = 2 ** 20;
const row = (pid: number, ppid: number, rssMb: number, command: string): string => `${pid} ${ppid} ${rssMb * 1024} ${command}`;
const SIM = "/Users/u/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/App";
const table = [
  row(10, 1, 900, SIM),
  row(11, 1, 300, "/usr/bin/claude --print"),
  row(12, 500, 200, "claude -p"), // child of a live session holder (pid 500)
  row(13, 1, 1000, "/Applications/Big.app/Contents/MacOS/Big"),
  row(14, 1, 10, "/bin/zsh"),
  "garbage line",
].join("\n");

describe("summarizeUnowned", () => {
  it.each([
    ["no session holder: both claude rows count", [999], 500 * MB],
    ["a claude row under a live session holder is excluded", [500], 300 * MB],
    ["a claude row with any other parent is counted", [1], 200 * MB],
  ])("%s", (_name, sessionPids, claude) => {
    expect(summarizeUnowned(table, sessionPids).claude).toBe(claude);
  });

  it("counts simulators, lists a process above the threshold and drops one below it", () => {
    expect(summarizeUnowned(table, [500])).toMatchObject({ simulators: 900 * MB, others: [{ pid: 13, command: "/Applications/Big.app/Contents/MacOS/Big", bytes: 1000 * MB }] });
  });

  const RUNTIME = "/Library/Developer/CoreSimulator/Volumes/iOS_27A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard";
  it.each([
    ["a device data path", SIM, 600],
    ["a runtime process under Volumes/.../RuntimeRoot", RUNTIME, 600],
    ["a runtime process under another .simruntime root", "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/backboardd", 600],
    ["a process outside CoreSimulator", "/usr/libexec/backboardd", 0],
  ])("counts %s as a simulator", (_name, command, simMb) => {
    expect(summarizeUnowned(row(20, 1, 600, command), []).simulators).toBe(simMb * MB);
  });

  it("lists the five largest others, largest first", () => {
    const sizes = [700, 1500, 600, 2000, 900, 1200, 800];
    const text = sizes.map((mb, i) => row(30 + i, 1, mb, `/bin/p${i}`)).join("\n");
    expect(summarizeUnowned(text, []).others.map((o) => o.bytes / MB)).toEqual([2000, 1500, 1200, 900, 800]);
  });

  it.each([
    ["no heavy holder: the leased command is an other", [], [40, 41, 43]],
    ["a heavy holder's child and its descendants are left out", [40], [43]],
    ["a recorded child pid that is not in the table changes nothing", [99], [40, 41, 43]],
  ])("%s", (_name, heavyChildPids, pids) => {
    const text = [row(40, 1, 2000, "npm test"), row(41, 40, 1500, "node vitest"), row(42, 41, 100, "node worker"), row(43, 1, 900, "/bin/other")].join("\n");
    expect(summarizeUnowned(text, [], heavyChildPids).others.map((o) => o.pid)).toEqual(pids);
  });
});

describe("sampleUnowned", () => {
  let dir: string;
  let now: number;
  let calls: number;
  const sample = (text: string | Error = table) =>
    sampleUnowned({ dir, now: () => now, ps: (args) => { calls++; expect(args).toBe(UNOWNED_PS_ARGS); if (text instanceof Error) throw text; return text; } }, [500]);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unowned-"));
    now = 1_000_000;
    calls = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reuses the cached sample inside the window and re-reads after it", () => {
    const first = sample();
    expect(first?.simulators).toBe(900 * MB);
    now += UNOWNED_CACHE_MS - 1;
    expect(sample("")).toEqual(first);
    expect(calls).toBe(1);
    now += 1;
    expect(sample("")?.simulators).toBe(0);
    expect(calls).toBe(2);
  });

  it("returns undefined and writes nothing when ps fails", () => {
    expect(sample(new Error("boom"))).toBeUndefined();
    expect(() => readFileSync(join(dir, "unowned.json"))).toThrow();
  });

  it("ignores a malformed cache record", () => {
    writeFileSync(join(dir, "unowned.json"), "{nope");
    expect(sample()?.simulators).toBe(900 * MB);
    expect(calls).toBe(1);
  });

  it("still returns the sample when the cache cannot be written", () => {
    chmodSync(dir, 0o500);
    try {
      expect(sample()?.simulators).toBe(900 * MB);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
