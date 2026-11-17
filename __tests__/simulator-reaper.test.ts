import { describe, it, expect, beforeEach } from "vitest";
import { reapSimulators, realReaperDeps, SIMCTL_TIMEOUT_MS, type DeviceSet, type ReapResult, type ReaperDeps, type SimulatorReapEvent } from "../src/simulator-reaper.js";
import { parsePsTable, type ProcRow } from "../src/ps.js";
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

// A runtime process's environment as `ps -E` prints it: `SIMULATOR_UDID`, and a `HOME` under its device's own data directory, which names the
// device set the device lives in. A bare UDID means the main set.
type SetName = "main" | "xctest" | "previews";
type EnvSpec = string | undefined | { udid: string; set: SetName };
const HOMES: Record<SetName, (udid: string) => string> = {
  main: (u) => `/Users/x/Library/Developer/CoreSimulator/Devices/${u}/data`,
  xctest: (u) => `/Users/x/Library/Developer/XCTestDevices/${u}/data`,
  previews: (u) => `/Users/x/Library/Developer/Xcode/UserData/Previews/Simulator Devices/${u}/data`,
};
const envText = (spec: EnvSpec): string => {
  if (spec === undefined) return "HOME=/x";
  const { udid, set } = typeof spec === "string" ? { udid: spec, set: "main" as const } : spec;
  return `SIMULATOR_UDID=${udid} HOME=${HOMES[set](udid)}`;
};

describe("reapSimulators", () => {
  let events: SimulatorReapEvent[];
  let signals: [number, string][];
  let shutdowns: string[];
  let shutdownSets: DeviceSet[];
  let listCalls: DeviceSet[];
  let envLookups: number[][];
  let envOf: Record<number, EnvSpec>;
  // What the environment lookup right before a signal sees, when a test changes it (a reused pid), and whether that lookup fails.
  let envOfFresh: Record<number, EnvSpec> | undefined;
  let envFailsAfterFirst = false;
  let list: () => string;
  let testList: () => string;
  let shutdownFails: Error | undefined;
  let signalFails: Set<number>;

  const deps = (over: Partial<ReaperDeps> = {}): ReaperDeps => ({
    listDevices: (set) => (listCalls.push(set), set === "main" ? list() : testList()),
    processEnv: (pids) => {
      envLookups.push(pids);
      if (envFailsAfterFirst && envLookups.length > 1) throw new Error("ps timed out");
      const table = envLookups.length > 1 && envOfFresh ? envOfFresh : envOf;
      return pids.flatMap((pid) => (pid in table ? [`${pid} ${runtimeRow(pid).command} ${envText(table[pid])}`] : [])).join("\n");
    },
    shutdown: (udid, set) => {
      shutdowns.push(udid);
      shutdownSets.push(set);
      if (shutdownFails) throw shutdownFails;
    },
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      if (signalFails.has(pid)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    log: (e) => void events.push(e),
    scan: () => (scans++, freshRows ? freshRows() : currentRows),
    uid: MINE,
    ...over,
  });
  // A device is acted on only after it read Shutdown with the same pids on the previous cycle, so by default a call is the second cycle:
  // `seenIn` is every runtime row's pid grouped by the UDID its environment names; a first-cycle test sets it to `{}`.
  let seenIn: Record<string, number[]> | undefined;
  let lastResult: ReapResult;
  // The table the cycle decided on, and what a rescan right before an action sees (the same unless a test changes it).
  let currentRows: ProcRow[] = [];
  let freshRows: (() => ProcRow[]) | undefined;
  let scans = 0;
  const sightings = (rows: PsTextRow[]): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    for (const r of rows) {
      const spec = envOf[r.pid];
      const udid = typeof spec === "string" ? spec : spec?.udid;
      if (udid) out[udid] = [...(out[udid] ?? []), r.pid];
    }
    return out;
  };
  const reap = (rows: PsTextRow[], idleUdids: string[] = [], attempts: Record<string, number> = {}, over: Partial<ReaperDeps> = {}) => {
    currentRows = parsePsTable(psText(rows));
    lastResult = reapSimulators({ procs: currentRows, idleUdids, attempts, seen: seenIn ?? sightings(rows) }, deps(over));
    return lastResult.attempts;
  };

  beforeEach(() => {
    events = [];
    signals = [];
    shutdowns = [];
    shutdownSets = [];
    listCalls = [];
    freshRows = undefined;
    envOfFresh = undefined;
    envFailsAfterFirst = false;
    scans = 0;
    seenIn = undefined;
    envLookups = [];
    envOf = {};
    list = () => devices({ [U1]: "Shutdown" });
    testList = () => devices({});
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

    // Issue #324 review: `simctl list devices -j` covers one device set, so a device the list does not name may simply live in another set
    // (a test clone, a SwiftUI Previews device, a Playgrounds device) and be running. Only an explicit `Shutdown` from the list of the
    // device's own set is acted on; absence, an empty list and an unreadable list are unknown.
    it.each<[string, () => void]>([
      ["a valid but empty list", () => { list = () => devices({}); }],
      ["a list that names only other devices", () => { list = () => devices({ [U2]: "Shutdown" }); }],
      ["a list with no devices key", () => { list = () => "{}"; }],
      ["a list that cannot be read", () => { list = () => { throw new Error("simctl timed out"); }; }],
    ])("does nothing for a device its own set's list does not name: %s", (_name, setUp) => {
      setUp();
      reap(leftovers);
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
    });

    it("acts on a test clone the XCTestDevices list reports Shutdown", () => {
      envOf = { 300: { udid: U1, set: "xctest" }, 301: { udid: U1, set: "xctest" }, 302: { udid: U1, set: "xctest" } };
      list = () => devices({});
      testList = () => devices({ [U1]: "Shutdown" });
      reap(leftovers);
      expect(signals).toHaveLength(3);
    });

    it.each<[string, () => void]>([
      ["a clone the main list calls Shutdown but its own set does not name", () => { list = () => devices({ [U1]: "Shutdown" }); testList = () => devices({}); }],
      ["a clone its own set lists as Booted", () => { list = () => devices({ [U1]: "Shutdown" }); testList = () => devices({ [U1]: "Booted" }); }],
      ["a clone when the test set's list cannot be read", () => { testList = () => { throw new Error("simctl timed out"); }; }],
    ])("leaves %s alone", (_name, setUp) => {
      envOf = { 300: { udid: U1, set: "xctest" } };
      setUp();
      reap([runtimeRow(300)]);
      expect(signals).toEqual([]);
    });

    it("leaves a SwiftUI Previews or Playgrounds device alone, whatever the lists say", () => {
      envOf = { 300: { udid: U1, set: "previews" } };
      list = () => devices({ [U1]: "Shutdown" });
      testList = () => devices({ [U1]: "Shutdown" });
      expect(reap([runtimeRow(300)])).toEqual({});
      expect(signals).toEqual([]);
    });

    it("an unreadable test list does not stop main-set leftovers from being reaped, and the reverse", () => {
      envOf = { 300: U1, 301: { udid: U2, set: "xctest" } };
      testList = () => { throw new Error("simctl timed out"); };
      reap([runtimeRow(300), runtimeRow(301)]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
      signals.length = 0;
      testList = () => devices({ [U2]: "Shutdown" });
      list = () => { throw new Error("simctl timed out"); };
      reap([runtimeRow(300), runtimeRow(301)]);
      expect(signals).toEqual([[301, "SIGTERM"]]);
    });

    it("looks up the environment of simulator runtime rows only, in one call", () => {
      reap([...leftovers, { pid: 50, ppid: 1, pgid: 50, command: "zsh" }, runtimeRow(60, { command: "/Applications/Xcode.app/x" })]);
      expect(envLookups[0]).toEqual([300, 301, 302]);
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

  // Issue #324 review: one reading of Shutdown with processes still present is not enough (a device mid-boot or mid-shutdown can read so);
  // the same device must read Shutdown with the same pid and UDID on two consecutive cycles before anything is signalled.
  describe("confirming over two cycles", () => {
    const rows = [runtimeRow(300), runtimeRow(301), runtimeRow(302)];
    beforeEach(() => {
      envOf = { 300: U1, 301: U1, 302: U1 };
    });

    it("signals nothing the first cycle and records what it saw", () => {
      seenIn = {};
      expect(reap(rows)).toEqual({});
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
      expect(lastResult.seen).toEqual({ [U1]: [300, 301, 302] });
    });

    it("signals the second cycle, and only the pids seen both times", () => {
      seenIn = { [U1]: [300, 302, 999] };
      reap(rows);
      expect(signals).toEqual([[300, "SIGTERM"], [302, "SIGTERM"]]);
      expect(events[0]).toMatchObject({ pids: [300, 302] });
    });

    it("does not signal a pid that now belongs to another device's environment", () => {
      seenIn = { [U1]: [300] };
      envOf = { 300: U2 };
      list = () => devices({ [U1]: "Shutdown", [U2]: "Shutdown" });
      reap([runtimeRow(300)]);
      expect(signals).toEqual([]);
    });

    it("forgets a device that no longer reads Shutdown, so the count starts over", () => {
      seenIn = { [U1]: [300, 301, 302] };
      list = () => devices({ [U1]: "Booted" });
      reap(rows);
      expect(signals).toEqual([]);
      expect(lastResult.seen).toEqual({});
    });

    it("keeps the earlier sightings when the device's list cannot be read, and signals nothing", () => {
      seenIn = { [U1]: [300, 301, 302] };
      list = () => {
        throw new Error("simctl timed out");
      };
      reap(rows);
      expect(signals).toEqual([]);
      expect(lastResult.seen).toEqual({ [U1]: [300, 301, 302] });
    });

    it("signals again on every later cycle once confirmed, SIGKILL from the second attempt", () => {
      seenIn = { [U1]: [300, 301, 302] };
      reap(rows);
      expect(signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGTERM", "SIGTERM"]);
      signals.length = 0;
      seenIn = lastResult.seen;
      reap(rows, [], lastResult.attempts);
      expect(signals.map(([, s]) => s)).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
    });
  });

  // The owner uses simulators by hand in Simulator.app, so a booted device in the main set (~/Library/Developer/CoreSimulator/Devices)
  // is never shut down for being idle: no `xcodebuild` or `simctl` running says nothing about someone using it. Only a test clone in the
  // XCTestDevices set, which only `xcodebuild` creates, is.
  describe("a booted device idle past the threshold", () => {
    const launchd = (udid: string, set: "CoreSimulator/Devices" | "XCTestDevices"): PsTextRow => ({ pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim /Users/x/Library/Developer/${set}/${udid}/data/var/run/launchd_bootstrap.plist` });

    describe("in the XCTestDevices set", () => {
      beforeEach(() => {
        testList = () => devices({ [U1]: "Booted" });
      });

      it("is shut down with simctl in that set, and the action is logged", () => {
        reap([launchd(U1, "XCTestDevices")], [U1]);
        expect(shutdowns).toEqual([U1]);
        expect(shutdownSets).toEqual(["xctest"]);
        expect(events).toEqual([{ type: "simulator-reap", udid: U1, reason: "booted-idle", action: "shutdown", ok: true }]);
        expect(signals).toEqual([]);
      });

      it("logs a shutdown that fails with its message, and kills nothing", () => {
        shutdownFails = new Error("timed out after 30000ms");
        reap([launchd(U1, "XCTestDevices")], [U1]);
        expect(events).toEqual([{ type: "simulator-reap", udid: U1, reason: "booted-idle", action: "shutdown", ok: false, message: "timed out after 30000ms" }]);
        expect(signals).toEqual([]);
      });

      it("is left alone when the list says it is not Booted", () => {
        testList = () => devices({ [U1]: "Shutdown" });
        reap([launchd(U1, "XCTestDevices")], [U1]);
        expect(shutdowns).toEqual([]);
      });

      it("is not shut down when it is not in the idle list", () => {
        reap([launchd(U1, "XCTestDevices")], []);
        expect(shutdowns).toEqual([]);
      });
    });

    describe("in the main set", () => {
      beforeEach(() => {
        list = () => devices({ [U1]: "Booted" });
      });

      it("is never shut down, however long it has been idle", () => {
        reap([launchd(U1, "CoreSimulator/Devices")], [U1]);
        expect(shutdowns).toEqual([]);
        expect(events).toEqual([]);
        expect(signals).toEqual([]);
      });

      it("is never shut down even when it is also named in the idle list of a clone-free machine, and a clone beside it still is", () => {
        testList = () => devices({ [U2]: "Booted" });
        reap([launchd(U1, "CoreSimulator/Devices"), { ...launchd(U2, "XCTestDevices"), pid: 201 }], [U1, U2]);
        expect(shutdowns).toEqual([U2]);
      });
    });
  });

  // Issue #324 review: Xcode.app drives CoreSimulator itself, with no `xcodebuild` or `simctl` process, so a clone its parallel test run
  // is using looks idle to the watchdog. A clone is idle-shut only when Xcode.app is not running and nothing in the clone's tree but the
  // system runtime itself (the daemons under RuntimeRoot, outside RuntimeRoot/Developer) is running: no test runner, no app.
  describe("an idle test clone that something may be using", () => {
    const CLONE = `/Users/x/Library/Developer/XCTestDevices/${U1}`;
    const launchdRow: PsTextRow = { pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim ${CLONE}/data/var/run/launchd_bootstrap.plist` };
    const daemon: PsTextRow = { pid: 201, ppid: 200, pgid: 200, command: `${RT}/usr/libexec/backboardd` };
    beforeEach(() => {
      testList = () => devices({ [U1]: "Booted" });
    });
    const idleReap = (extra: PsTextRow[]) => reap([launchdRow, daemon, ...extra], [U1]);

    it("is shut down when only the system runtime is running", () => {
      idleReap([]);
      expect(shutdowns).toEqual([U1]);
    });

    it.each<[string, PsTextRow]>([
      ["Xcode.app", { pid: 900, ppid: 1, pgid: 900, command: "/Applications/Xcode.app/Contents/MacOS/Xcode" }],
      ["a beta Xcode.app", { pid: 900, ppid: 1, pgid: 900, command: "/Applications/Xcode-beta.app/Contents/MacOS/Xcode" }],
      ["an Xcode.app in a path with spaces", { pid: 900, ppid: 1, pgid: 900, command: "/Applications/Xcode 27 Beta.app/Contents/MacOS/Xcode" }],
    ])("is left alone while %s runs, wherever its windows are", (_name, row) => {
      idleReap([row]);
      expect(shutdowns).toEqual([]);
      expect(events).toEqual([]);
    });

    it.each<[string, PsTextRow]>([
      ["an app under the clone's containers", { pid: 300, ppid: 200, pgid: 300, command: `${CLONE}/data/Containers/Bundle/Application/ABC/App.app/App` }],
      ["a UI test runner app under the clone's containers", { pid: 300, ppid: 200, pgid: 300, command: `${CLONE}/data/Containers/Bundle/Application/ABC/AppUITests-Runner.app/AppUITests-Runner` }],
      ["the test agent the runtime ships under RuntimeRoot/Developer", { pid: 300, ppid: 200, pgid: 300, command: `${RT}/Developer/Library/Xcode/Agents/xctest` }],
      ["any other process of the clone's tree", { pid: 300, ppid: 201, pgid: 300, command: "/private/var/runner --serve" }],
      ["a process that names the clone's UDID outside its tree", { pid: 300, ppid: 1, pgid: 300, command: `/usr/bin/some-tool --device ${U1.toLowerCase()}` }],
    ])("is left alone while %s runs", (_name, row) => {
      idleReap([row]);
      expect(shutdowns).toEqual([]);
      expect(events).toEqual([]);
    });

    it("is not held back by a process that only names another device", () => {
      idleReap([{ pid: 300, ppid: 1, pgid: 300, command: `/usr/bin/some-tool --device ${U2}` }]);
      expect(shutdowns).toEqual([U1]);
    });

    it("is not held back by an unrelated process of the same user", () => {
      idleReap([{ pid: 300, ppid: 50, pgid: 300, command: "node server.js" }]);
      expect(shutdowns).toEqual([U1]);
    });
  });

  // Issue #324 review: the decision was made on a scan that is seconds old by the time `simctl` and the signals run (a list read can take 30 s),
  // so the process table is read again right before each device's action, once per action, and every guard is applied to that fresh table.
  describe("a stale scan", () => {
    const leftovers = [runtimeRow(300), runtimeRow(301)];
    const CLONE = `/Users/x/Library/Developer/XCTestDevices/${U1}`;
    const clone: PsTextRow[] = [
      { pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim ${CLONE}/data/var/run/launchd_bootstrap.plist` },
      { pid: 201, ppid: 200, pgid: 200, command: `${RT}/usr/libexec/backboardd` },
    ];
    const rowsOf = (rows: PsTextRow[]): ProcRow[] => parsePsTable(psText(rows));

    describe("before a signal", () => {
      beforeEach(() => {
        envOf = { 300: U1, 301: U1 };
      });

      it("reads the table again once for the device's batch, not once per pid", () => {
        reap(leftovers);
        expect(scans).toBe(1);
        expect(signals).toHaveLength(2);
      });

      it.each<[string, PsTextRow]>([
        ["a test action that started meanwhile", { pid: 900, ppid: 50, pgid: 900, command: "xcodebuild test -scheme App" }],
        ["a build tool that now names the device", { pid: 900, ppid: 50, pgid: 900, command: `xcodebuild build -destination id=${U1}` }],
        ["a simctl that now names the device", { pid: 900, ppid: 50, pgid: 900, command: `xcrun simctl spawn ${U1} launchctl list` }],
      ])("signals nothing when %s", (_name, row) => {
        freshRows = () => rowsOf([...leftovers, row]);
        reap(leftovers);
        expect(signals).toEqual([]);
        expect(events).toEqual([]);
      });

      it("signals only the pids still present, as a simulator process of this user, in the fresh table", () => {
        freshRows = () => rowsOf([leftovers[0]!, runtimeRow(301, { command: "/usr/bin/other-tool" })]);
        reap(leftovers);
        expect(signals).toEqual([[300, "SIGTERM"]]);
      });

      it("signals a pid that now belongs to another user to nobody", () => {
        freshRows = () => rowsOf([runtimeRow(300, { uid: 0 }), leftovers[1]!]);
        reap(leftovers);
        expect(signals).toEqual([[301, "SIGTERM"]]);
      });

      it("signals nothing, and keeps what it knew, when the fresh scan cannot be read", () => {
        freshRows = () => {
          throw new Error("ps timed out");
        };
        reap(leftovers, [], { [U1]: 1 });
        expect(signals).toEqual([]);
        expect(events).toEqual([]);
        expect(lastResult.attempts).toEqual({ [U1]: 1 });
      });
    });

    describe("before a shutdown", () => {
      beforeEach(() => {
        testList = () => devices({ [U1]: "Booted" });
      });

      it("reads the table again once for the clone's shutdown", () => {
        reap(clone, [U1]);
        expect(scans).toBe(1);
        expect(shutdowns).toEqual([U1]);
      });

      it.each<[string, PsTextRow]>([
        ["Xcode.app that started meanwhile", { pid: 900, ppid: 1, pgid: 900, command: "/Applications/Xcode.app/Contents/MacOS/Xcode" }],
        ["a test action that started meanwhile", { pid: 900, ppid: 50, pgid: 900, command: "xcodebuild test -scheme App" }],
        ["a tool that now names the clone", { pid: 900, ppid: 50, pgid: 900, command: `xcrun simctl io ${U1} screenshot x.png` }],
        ["a test runner that started in the clone", { pid: 300, ppid: 201, pgid: 300, command: `${CLONE}/data/Containers/Bundle/Application/ABC/AppUITests-Runner.app/AppUITests-Runner` }],
      ])("is not run when %s", (_name, row) => {
        freshRows = () => rowsOf([...clone, row]);
        reap(clone, [U1]);
        expect(shutdowns).toEqual([]);
        expect(events).toEqual([]);
      });

      it("is not run when the clone's launchd is gone from the fresh table", () => {
        freshRows = () => rowsOf([]);
        reap(clone, [U1]);
        expect(shutdowns).toEqual([]);
      });

      it("is not run when the fresh scan cannot be read", () => {
        freshRows = () => {
          throw new Error("ps timed out");
        };
        reap(clone, [U1]);
        expect(shutdowns).toEqual([]);
        expect(events).toEqual([]);
      });
    });

    it("reads no table at all when nothing is acted on", () => {
      reap([{ pid: 50, ppid: 1, pgid: 50, command: "zsh" }]);
      expect(scans).toBe(0);
    });
  });

  // Issue #324 review: a Shutdown device with a live `launchd_sim` is not shut down (it is booting, or shutting down), and the rescan re-reads each
  // pid's environment, so a pid that was reused by a process of another device, or that no longer names the device, is not signalled.
  describe("a device that may still be alive", () => {
    const leftovers = [runtimeRow(300), runtimeRow(301)];
    const launchd = (udid: string, dir: string): PsTextRow => ({ pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim /Users/x/Library/Developer/${dir}/${udid}/data/var/run/launchd_bootstrap.plist` });
    beforeEach(() => {
      envOf = { 300: U1, 301: U1 };
    });

    it.each<[string, PsTextRow]>([
      ["a main-set launchd_sim for the device", launchd(U1, "CoreSimulator/Devices")],
      ["a test-set launchd_sim for the device", launchd(U1, "XCTestDevices")],
    ])("is left alone while %s is alive in the scan the decision was made on", (_name, row) => {
      reap([...leftovers, row]);
      expect(signals).toEqual([]);
      expect(events).toEqual([]);
    });

    it("is left alone when the launchd_sim appears only in the rescan", () => {
      freshRows = () => parsePsTable(psText([...leftovers, launchd(U1, "CoreSimulator/Devices")]));
      reap(leftovers);
      expect(signals).toEqual([]);
    });

    it("is left alone when the launchd_sim was in the scan the decision was made on, even if the rescan no longer shows it", () => {
      freshRows = () => parsePsTable(psText(leftovers));
      reap([...leftovers, launchd(U1, "CoreSimulator/Devices")]);
      expect(signals).toEqual([]);
    });

    it("signals no pid whose environment names another device than its home path does", () => {
      let calls = 0;
      const processEnv = (pids: number[]): string => {
        calls++;
        const udid = (pid: number): string => (calls > 1 && pid === 301 ? U2 : U1);
        return pids.map((pid) => `${pid} ${runtimeRow(pid).command} SIMULATOR_UDID=${udid(pid)} HOME=${HOMES.main(U1)}`).join("\n");
      };
      reap(leftovers, [], {}, { processEnv });
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });

    it("is not held back by another device's launchd_sim", () => {
      reap([...leftovers, launchd(U2, "CoreSimulator/Devices")]);
      expect(signals).toHaveLength(2);
    });

    it("reads each pid's environment again in the rescan, and signals only the pids that still name the device", () => {
      envOfFresh = { 300: U1, 301: U2 };
      reap(leftovers);
      expect(envLookups).toEqual([[300, 301], [300, 301]]);
      expect(signals).toEqual([[300, "SIGTERM"]]);
    });

    it("signals no pid whose environment cannot be read again, or names no device any more", () => {
      envOfFresh = { 300: undefined };
      reap(leftovers);
      expect(signals).toEqual([]);
    });

    it("signals nothing when the second environment lookup fails, and keeps what it knew", () => {
      envFailsAfterFirst = true;
      reap(leftovers, [], { [U1]: 1 });
      expect(signals).toEqual([]);
      expect(lastResult.attempts).toEqual({ [U1]: 1 });
    });

    it("does not read the environment a second time for a device nothing is signalled for", () => {
      list = () => devices({ [U1]: "Booted" });
      reap(leftovers);
      expect(envLookups).toHaveLength(1);
    });
  });

  describe("the device lists", () => {
    it("are not read when there are no simulator rows and no idle devices", () => {
      reap([{ pid: 50, ppid: 1, pgid: 50, command: "zsh" }]);
      expect(listCalls).toEqual([]);
    });

    it("are read when there are runtime rows", () => {
      envOf = { 300: U1 };
      reap([runtimeRow(300)]);
      expect(listCalls.sort()).toEqual(["main", "xctest"]);
    });

    it("are read when there is an idle device and no runtime row of this user", () => {
      reap([{ pid: 50, ppid: 1, pgid: 50, command: "zsh" }], [U1]);
      expect(listCalls.sort()).toEqual(["main", "xctest"]);
    });

    it("are not read for another user's simulator rows alone", () => {
      reap([runtimeRow(300, { uid: 0 })]);
      expect(listCalls).toEqual([]);
    });
  });

  describe("never touches a device that is in use", () => {
    beforeEach(() => {
      list = () => devices({ [U1]: "Shutdown" });
      testList = () => devices({ [U2]: "Booted" });
      envOf = { 300: U1 };
    });
    const idleLaunchd: PsTextRow = { pid: 200, ppid: 1, pgid: 200, command: `${RT}/sbin/launchd_sim /Users/x/Library/Developer/XCTestDevices/${U2}/data/x` };

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
  const TEST_DIR = "/Users/x/Library/Developer/XCTestDevices";
  const fake = (out = "") => (file: string, args: string[], timeoutMs: number): string => (calls.push({ file, args, timeoutMs }), out);
  const build = (over: Partial<Parameters<typeof realReaperDeps>[0]> = {}) => realReaperDeps({ exec: fake("{}"), uid: MINE, log: () => {}, testSetDir: TEST_DIR, exists: () => true, ...over });
  beforeEach(() => void (calls.length = 0));

  it("lists the main set as JSON through xcrun simctl, bounded", () => {
    expect(build().listDevices("main")).toBe("{}");
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "list", "devices", "-j"], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("lists the XCTestDevices set with --set, bounded", () => {
    build().listDevices("xctest");
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "--set", TEST_DIR, "list", "devices", "-j"], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("lists no devices, and runs nothing, when the XCTestDevices directory does not exist", () => {
    expect(JSON.parse(build({ exists: () => false }).listDevices("xctest"))).toEqual({ devices: {} });
    expect(calls).toEqual([]);
  });

  it("shuts a main-set device down through xcrun simctl, naming only the UDID", () => {
    build().shutdown(U1, "main");
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "shutdown", U1], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("shuts a test clone down in its own set", () => {
    build().shutdown(U1, "xctest");
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "--set", TEST_DIR, "shutdown", U1], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("reads the environment of exactly the named pids with ps -E", () => {
    build({ exec: fake("300 cmd SIMULATOR_UDID=x") }).processEnv([300, 301]);
    expect(calls).toEqual([{ file: "ps", args: ["-Eww", "-p", "300,301", "-o", "pid=,command="], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  // `ps -p` exits 1 when any listed pid is gone by the time it runs, though it prints the rest.
  it("uses the rows of a ps that exits 1 because a listed pid vanished", () => {
    const exits = (status: number, stdout: unknown) => (): string => {
      throw Object.assign(new Error(`exit ${status}`), { status, stdout });
    };
    expect(build({ exec: exits(1, "300 cmd SIMULATOR_UDID=x") }).processEnv([300, 301])).toBe("300 cmd SIMULATOR_UDID=x");
    expect(() => build({ exec: exits(1, "") }).processEnv([300])).toThrow("exit 1");
    expect(() => build({ exec: exits(2, "300 cmd") }).processEnv([300])).toThrow("exit 2");
    expect(() => build({ exec: exits(1, undefined) }).processEnv([300])).toThrow("exit 1");
  });

  it("reads the process table through ps with the one table's arguments, bounded", () => {
    const rows = build({ exec: fake("  200     1   200   501 S      02:00:00   4096 /sbin/launchd_sim x\n") }).scan();
    expect(rows).toMatchObject([{ pid: 200, ppid: 1, uid: 501, command: "/sbin/launchd_sim x" }]);
    expect(calls).toEqual([{ file: "ps", args: ["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,rss=,command="], timeoutMs: SIMCTL_TIMEOUT_MS }]);
  });

  it("does not run ps for no pids", () => {
    expect(build({ exec: fake("x") }).processEnv([])).toBe("");
    expect(calls).toEqual([]);
  });
});
