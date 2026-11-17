import { describe, it, expect, beforeEach } from "vitest";
import { reapSimulators, realReaperDeps, SIMCTL_TIMEOUT_MS, type ReaperDeps, type SimulatorReapEvent } from "../src/simulator-reaper.js";
import { parsePsTable } from "../src/ps.js";
import { psText, type PsTextRow } from "./helpers/ps-text.js";

// Issue #324, defect 3. On 2026-11-16 about 16:16 PST a simulator's device went Shutdown while 110 of its runtime processes
// (parent launchd gone, `SIMULATOR_UDID` in their environment) kept running about two hours at up to 200% CPU. Every
// external call here is an injected seam (a scripted `simctl list`, `ps -E`, `kill` and `simctl shutdown`): no test runs a simulator.

const U1 = "5E2F590B-1111-4222-8333-444455556666";
const U2 = "9F8E7D6C-1111-4222-8333-444455556666";
const MINE = 501;
const RT = "/Library/Developer/CoreSimulator/Volumes/iOS_23A/Library/Developer/CoreSimulator/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot";
const DEV = "/Users/x/Library/Developer/CoreSimulator/Devices";

const runtimeRow = (pid: number, over: Partial<PsTextRow> = {}): PsTextRow => ({ pid, ppid: 1, pgid: pid, command: `${RT}/usr/libexec/daemon${pid}`, ...over });
const devices = (states: Record<string, string>): string =>
  JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-2": Object.entries(states).map(([udid, state]) => ({ udid, state, name: "iPhone" })) } });

describe("reapSimulators", () => {
  let events: SimulatorReapEvent[];
  let signals: [number, string][];
  let shutdowns: string[];
  let envLookups: number[][];
  let envOf: Record<number, string | undefined>;
  let list: () => string;
  let shutdownFails: Error | undefined;
  let signalFails: Set<number>;

  const deps = (over: Partial<ReaperDeps> = {}): ReaperDeps => ({
    listDevices: () => list(),
    processEnv: (pids) => {
      envLookups.push(pids);
      return pids.flatMap((pid) => (pid in envOf ? [`${pid} ${runtimeRow(pid).command} ${envOf[pid] === undefined ? "HOME=/x" : `SIMULATOR_UDID=${envOf[pid]} HOME=/x`}`] : [])).join("\n");
    },
    shutdown: (udid) => {
      shutdowns.push(udid);
      if (shutdownFails) throw shutdownFails;
    },
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      if (signalFails.has(pid)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    log: (e) => void events.push(e),
    uid: MINE,
    ...over,
  });
  const reap = (rows: PsTextRow[], idleUdids: string[] = [], attempts: Record<string, number> = {}, over: Partial<ReaperDeps> = {}) =>
    reapSimulators({ procs: parsePsTable(psText(rows)), idleUdids, attempts }, deps(over));

  beforeEach(() => {
    events = [];
    signals = [];
    shutdowns = [];
    envLookups = [];
    envOf = {};
    list = () => devices({ [U1]: "Shutdown" });
    shutdownFails = undefined;
    signalFails = new Set();
  });

  describe("a Shutdown device's leftover runtime processes", () => {
    const leftovers = [runtimeRow(300), runtimeRow(301), runtimeRow(302)];
    beforeEach(() => {
      envOf = { 300: U1, 301: U1, 302: U1 };
    });

    it("terminates each with SIGTERM the first cycle and logs one event", () => {
      const next = reap(leftovers);
      expect(signals).toEqual([[300, "SIGTERM"], [301, "SIGTERM"], [302, "SIGTERM"]]);
      expect(events).toEqual([{ type: "simulator-reap", udid: U1, reason: "shutdown-leftovers", action: "terminate", pids: [300, 301, 302], ok: true }]);
      expect(next).toEqual({ [U1]: 1 });
      expect(shutdowns).toEqual([]);
    });

    it("escalates to SIGKILL when they outlive the first cycle", () => {
      const next = reap(leftovers, [], { [U1]: 1 });
      expect(signals.map(([, s]) => s)).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
      expect(events[0]).toMatchObject({ action: "kill", pids: [300, 301, 302], ok: true });
      expect(next).toEqual({ [U1]: 2 });
    });

    it("forgets a device whose leftovers are gone", () => {
      expect(reap([runtimeRow(900, { command: "node app.js" })], [], { [U1]: 2 })).toEqual({});
      expect(signals).toEqual([]);
    });

    it("treats a device missing from the list as Shutdown", () => {
      list = () => devices({});
      reap(leftovers);
      expect(signals).toHaveLength(3);
    });

    it("looks up the environment of simulator runtime rows only, in one call", () => {
      reap([...leftovers, { pid: 50, ppid: 1, pgid: 50, command: "zsh" }, runtimeRow(60, { command: "/Applications/Xcode.app/x" })]);
      expect(envLookups).toEqual([[300, 301, 302]]);
    });

    it.each<[string, () => void, PsTextRow[]]>([
      ["another user's process", () => {}, [runtimeRow(300, { uid: 0 })]],
      ["a process whose environment names no device", () => { envOf = { 300: undefined }; }, [runtimeRow(300)]],
      ["a process whose environment cannot be read", () => { envOf = {}; }, [runtimeRow(300)]],
    ])("leaves %s alone", (_name, setUp, rows) => {
      setUp();
      reap(rows);
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
    });

    it("records a signal that fails, still signals the rest, and says which", () => {
      signalFails = new Set([301]);
      reap(leftovers);
      expect(signals.map(([p]) => p)).toEqual([300, 301, 302]);
      expect(events).toEqual([
        { type: "simulator-reap", udid: U1, reason: "shutdown-leftovers", action: "terminate", pids: [300, 302], ok: true },
        { type: "simulator-reap", udid: U1, reason: "shutdown-leftovers", action: "terminate", pids: [301], ok: false, message: "EPERM" },
      ]);
    });

    it("never touches a device the list reports Booted", () => {
      list = () => devices({ [U1]: "Booted" });
      expect(reap(leftovers)).toEqual({});
      expect(signals).toEqual([]);
    });

    it.each(["Shutting Down", "Creating", "Unknown"])("never touches a device in state %s", (state) => {
      list = () => devices({ [U1]: state });
      reap(leftovers);
      expect(signals).toEqual([]);
    });

    it("touches nothing when the device list cannot be read, and says nothing", () => {
      list = () => {
        throw new Error("simctl timed out");
      };
      expect(reap(leftovers, [], { [U1]: 1 })).toEqual({ [U1]: 1 });
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
    });

    it("touches nothing when the device list is not JSON", () => {
      list = () => "not json";
      reap(leftovers);
      expect(signals).toEqual([]);
    });

    it("keeps each device's leftovers apart", () => {
      list = () => devices({ [U1]: "Shutdown", [U2]: "Booted" });
      envOf = { 300: U1, 301: U2 };
      reap([runtimeRow(300), runtimeRow(301)]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });
  });

  describe("a booted device idle past the threshold", () => {
    beforeEach(() => {
      list = () => devices({ [U1]: "Booted" });
    });
    const launchd = (udid: string): PsTextRow => ({ pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim ${DEV}/${udid}/data/var/run/launchd_bootstrap.plist` });

    it("is shut down with simctl, and the action is logged", () => {
      reap([launchd(U1)], [U1]);
      expect(shutdowns).toEqual([U1]);
      expect(events).toEqual([{ type: "simulator-reap", udid: U1, reason: "booted-idle", action: "shutdown", ok: true }]);
      expect(signals).toEqual([]);
    });

    it("logs a shutdown that fails with its message, and kills nothing", () => {
      shutdownFails = new Error("timed out after 30000ms");
      reap([launchd(U1)], [U1]);
      expect(events).toEqual([{ type: "simulator-reap", udid: U1, reason: "booted-idle", action: "shutdown", ok: false, message: "timed out after 30000ms" }]);
      expect(signals).toEqual([]);
    });

    it("is left alone when the list says it is not Booted", () => {
      list = () => devices({ [U1]: "Shutdown" });
      reap([launchd(U1)], [U1]);
      expect(shutdowns).toEqual([]);
    });

    it("is not shut down when it is not in the idle list", () => {
      reap([launchd(U1)], []);
      expect(shutdowns).toEqual([]);
    });
  });

  describe("never touches a device that is in use", () => {
    beforeEach(() => {
      list = () => devices({ [U1]: "Shutdown", [U2]: "Booted" });
      envOf = { 300: U1 };
    });
    const idleLaunchd: PsTextRow = { pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim ${DEV}/${U2}/data/x` };

    it.each<[string, string]>([
      ["an xcodebuild test action", "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone'"],
      ["test-without-building", "xcodebuild test-without-building -xctestrun /x.xctestrun"],
      ["an xcodebuild test action by xcrun", "xcrun xcodebuild test -scheme App"],
      ["a test action under a spaced Xcode path", "/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/xcodebuild test -scheme App"],
    ])("while %s runs anywhere on the machine", (_name, command) => {
      reap([runtimeRow(300), idleLaunchd, { pid: 900, ppid: 50, pgid: 900, command }], [U2]);
      expect(signals).toEqual([]);
      expect(shutdowns).toEqual([]);
      expect(events).toEqual([]);
    });

    it.each<[string, string]>([
      ["an xcodebuild naming the leftovers' device", `xcodebuild build -scheme App -destination id=${U1}`],
      ["a simctl naming it, in lower case", `xcrun simctl spawn ${U1.toLowerCase()} launchctl list`],
    ])("while %s runs", (_name, command) => {
      reap([runtimeRow(300), { pid: 900, ppid: 50, pgid: 900, command }]);
      expect(signals).toEqual([]);
    });

    it("while a simctl names the idle device, but still reaps another device's leftovers", () => {
      reap([runtimeRow(300), idleLaunchd, { pid: 900, ppid: 50, pgid: 900, command: `xcrun simctl io ${U2} screenshot x.png` }], [U2]);
      expect(shutdowns).toEqual([]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });

    it("but an xcodebuild build of an unrelated device does not block it", () => {
      reap([runtimeRow(300), { pid: 900, ppid: 50, pgid: 900, command: `xcodebuild build -scheme App -destination id=${U2}` }]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });

    it("but a command that only mentions the tool as text does not block it", () => {
      reap([runtimeRow(300), { pid: 900, ppid: 50, pgid: 900, command: 'grep -rn "xcodebuild test" docs' }]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });
  });
});

describe("realReaperDeps", () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const fake = (out = "") => (file: string, args: string[], timeoutMs: number): string => (calls.push({ file, args, timeoutMs }), out);
  beforeEach(() => void (calls.length = 0));

  it("lists devices as JSON through xcrun simctl, bounded", () => {
    expect(realReaperDeps({ exec: fake("{}"), uid: MINE, log: () => {} }).listDevices()).toBe("{}");
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "list", "devices", "-j"], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("shuts a device down through xcrun simctl, bounded, naming only the UDID", () => {
    realReaperDeps({ exec: fake(), uid: MINE, log: () => {} }).shutdown(U1);
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "shutdown", U1], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("reads the environment of exactly the named pids with ps -E", () => {
    realReaperDeps({ exec: fake("300 cmd SIMULATOR_UDID=x"), uid: MINE, log: () => {} }).processEnv([300, 301]);
    expect(calls).toEqual([{ file: "ps", args: ["-Eww", "-p", "300,301", "-o", "pid=,command="], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("does not run ps for no pids", () => {
    expect(realReaperDeps({ exec: fake("x"), uid: MINE, log: () => {} }).processEnv([])).toBe("");
    expect(calls).toEqual([]);
  });
});
