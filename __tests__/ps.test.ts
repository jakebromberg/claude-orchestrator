import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { ancestry, groupAlive, signalGroup, isPid, pidAlive, parseElapsed, parsePsTable, ps, psField, psAncestors, PS_TABLE_ARGS, isSimulatorCommand, runsTool, simulatorUdid, xcTestDeviceUdid, XCODE_TOOLS, isTestRunnerProcess, isXcodebuildTestProcess, isXctestProcess, hasXcodeAppAncestor, hungTestCandidates, isBuildToolProcess, xcodeAppRunning, runningUiTestPids, XCODEBUILD_VALUED, type ProcRow } from "../src/ps.js";
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
const row = (pid: number, ppid: number, over: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid, pgid: pid, uid: 501, stat: "S", elapsedMs: 120 * MIN, rssBytes: 4096 * 1024, command: `cmd${pid}`, ...over });

describe("PS_TABLE_ARGS", () => {
  it("asks for the eight columns parsePsTable reads, with no header", () => {
    expect(PS_TABLE_ARGS).toEqual(["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,rss=,command="]);
  });
});

describe("parsePsTable", () => {
  it.each<[string, string, ProcRow[]]>([
    ["a full row", psText([{ pid: 12, ppid: 3, pgid: 9, uid: 0, stat: "Ss", etime: "05:00", command: "node run.js" }]), [row(12, 3, { pgid: 9, uid: 0, stat: "Ss", elapsedMs: 5 * MIN, command: "node run.js" })]],
    ["a command with spaces", psText([{ pid: 5, ppid: 1, pgid: 5, command: "node  a.js --flag  'x y'" }]), [row(5, 1, { command: "node  a.js --flag  'x y'" })]],
    ["a stat with flags", psText([{ pid: 5, ppid: 1, pgid: 5, stat: "T+N<s", command: "vim" }]), [row(5, 1, { stat: "T+N<s", command: "vim" })]],
    ["padded columns", "  7   1   7 501 S 02:00:00 4096 sleep 9", [row(7, 1, { command: "sleep 9" })]],
    ["a malformed line between good ones", `${psText([{ pid: 5, ppid: 1, pgid: 5, command: "a" }])}\nnot a row\n${psText([{ pid: 6, ppid: 1, pgid: 6, command: "b" }])}`, [row(5, 1, { command: "a" }), row(6, 1, { command: "b" })]],
    ["a row missing the command", "5 1 5 501 S 02:00:00 4096", []],
    ["an empty table", "", []],
    ["an rss value", psText([{ pid: 5, ppid: 1, pgid: 5, rss: 2048, command: "a" }]), [row(5, 1, { rssBytes: 2048 * 1024, command: "a" })]],
    ["an unreadable rss", psText([{ pid: 5, ppid: 1, pgid: 5, rss: "abc", command: "a" }]), [row(5, 1, { rssBytes: NaN, command: "a" })]],
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

describe("groupAlive and signalGroup", () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const killing = (err?: Error) => vi.fn((_pid: number, _sig: any) => { if (err) throw err; });

  it.each([
    ["success", undefined, true],
    ["ESRCH", errno("ESRCH"), false],
    ["EPERM", errno("EPERM"), true],
  ])("groupAlive probes -pgid with signal 0: %s", (_n, err, want) => {
    const kill = killing(err);
    expect(groupAlive(42, kill)).toBe(want);
    expect(kill).toHaveBeenCalledWith(-42, 0);
  });

  it.each([
    ["success", undefined, true],
    ["ESRCH", errno("ESRCH"), false],
  ])("signalGroup signals -pgid: %s", (_n, err, want) => {
    const kill = killing(err);
    expect(signalGroup(42, "SIGSTOP", kill)).toBe(want);
    expect(kill).toHaveBeenCalledWith(-42, "SIGSTOP");
  });

  it("signalGroup propagates another errno", () => {
    expect(() => signalGroup(42, "SIGSTOP", killing(errno("EPERM")))).toThrow("EPERM");
  });

  it.each([0, -5, 1.5, 2 ** 31, NaN])("refuses non-pid %s without calling kill", (pgid) => {
    const kill = killing();
    expect(groupAlive(pgid, kill)).toBe(false);
    expect(signalGroup(pgid, "SIGKILL", kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("isSimulatorCommand", () => {
  it.each([
    ["a device data path", "/Users/u/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/App", true],
    ["a runtime process under Volumes/.../RuntimeRoot", "/Library/Developer/CoreSimulator/Volumes/iOS_27A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard", true],
    ["a runtime process under another .simruntime root", "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/backboardd", true],
    ["a process outside CoreSimulator", "/usr/libexec/backboardd", false],
  ])("classifies %s", (_name, command, expected) => {
    expect(isSimulatorCommand(command)).toBe(expected);
  });
});

describe("runsTool", () => {
  it.each([
    ["a bare name", "xcodebuild test", true],
    ["an absolute path", "/usr/bin/xcodebuild test", true],
    ["xcrun simctl", "/usr/bin/xcrun simctl list", true],
    ["a path with two spaces", "/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/xcodebuild test", true],
    ["after &&", "cd x && xcodebuild test", true],
    ["a name that only ends in the word", "mysimctl list", false],
    ["a name that only starts with the word", "xcodebuild-helper run", false],
    ["no match", "npm test", false],
  ])("classifies %s", (_name, command, expected) => {
    expect(runsTool(command, XCODE_TOOLS)).toBe(expected);
  });
});

describe("xcTestDeviceUdid and simulatorUdid name different device sets (issue #324)", () => {
  const U = "5E2F590B-1111-4222-8333-444455556666";
  it("reads a test clone's UDID from its XCTestDevices path only", () => {
    expect(xcTestDeviceUdid(`/launchd_sim /Users/x/Library/Developer/XCTestDevices/${U.toLowerCase()}/data/x`)).toBe(U);
    expect(xcTestDeviceUdid(`/launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${U}/data/x`)).toBeUndefined();
    expect(xcTestDeviceUdid("/usr/bin/other-tool")).toBeUndefined();
  });
  it("is not read as a main-set device", () => {
    expect(simulatorUdid(`/launchd_sim /Users/x/Library/Developer/XCTestDevices/${U}/data/x`)).toBeUndefined();
  });
});

// Issue #324 review: the UI-test slot is withheld while a test action of the build tool is running with no slot behind it. The process itself must be
// the build tool, not a shell or tool whose command line only contains its name, or a Bash call's own shell would block the run it holds.
describe("isXcodebuildTestProcess", () => {
  const TOOL = "xcodebuild";
  it.each<[string, string]>([
    ["a test action by name", `${TOOL} test -scheme App`],
    ["test-without-building", `${TOOL} test-without-building -xctestrun x.xctestrun`],
    ["an Xcode path", `/Applications/Xcode.app/Contents/Developer/usr/bin/${TOOL} -scheme App test`],
    ["a path with spaces and a dash", `/Applications/Xcode-beta 2.app/Contents/Developer/usr/bin/${TOOL} -scheme A -destination platform=iOS test`],
    ["through xcrun", `xcrun ${TOOL} test -scheme App`],
    ["through xcrun with options", `xcrun --sdk iphonesimulator ${TOOL} test`],
    ["a preceding action", `${TOOL} clean test`],
    ["a scheme named test and then the action", `${TOOL} -scheme test test`],
    ["a flag, not a valued option, before the action", `${TOOL} -retry-tests-on-failure test`],
    ["a path with spaces in an .app bundle", `/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/${TOOL} -scheme A test`],
  ])("is true for %s", (_name, command) => {
    expect(isXcodebuildTestProcess(command)).toBe(true);
  });

  it.each<[string, string]>([
    ["a build action", `${TOOL} build -scheme App`],
    ["a settings query", `/x/usr/bin/${TOOL} -showBuildSettings`],
    ["a shell whose script holds the words", `zsh -c eval 'cd /w && ${TOOL} -scheme S test'`],
    ["a bash -c with the words", `bash -c '${TOOL} test'`],
    ["a grep for the words", `grep -rn "${TOOL} test" docs`],
    ["the lease CLI naming its argv", `node /x/dist/src/cli-lease.js -- ${TOOL} -scheme S test`],
    ["a similarly named tool", `my${TOOL} test`],
    ["a longer action", `${TOOL} testing`],
    ["no action", TOOL],
    ["an empty command", ""],
    // Issue #324 review: an option's value is not the action, and the path prefix does not run across the spaces of another command.
    ["a scheme named test and a build action", `${TOOL} -scheme test build`],
    ["a project named test", `${TOOL} -project test -scheme App build`],
    ["a destination named test", `${TOOL} -destination test build`],
    ["a shell whose script ends in the build tool and test", `/bin/zsh -c cd /w && /Applications/Xcode.app/Contents/Developer/usr/bin/${TOOL} test`],
    ["a shell with a later path to the build tool", `/bin/sh -c /x/y/${TOOL} test`],
    ["a wrapper that is not the build tool itself", `/usr/bin/time -l /x/${TOOL} test`],
  ])("is false for %s", (_name, command) => {
    expect(isXcodebuildTestProcess(command)).toBe(false);
  });
});

describe("runningUiTestPids", () => {
  const row = (pid: number, ppid: number, command: string, uid = 501) => ({ pid, ppid, pgid: pid, uid, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  const TEST = "xcodebuild test -scheme App";

  it("lists this user's test actions", () => {
    expect(runningUiTestPids([row(10, 1, TEST), row(11, 1, "zsh"), row(12, 1, "xcodebuild build")], 501, 99)).toEqual([10]);
  });

  it("leaves out other users' processes", () => {
    expect(runningUiTestPids([row(10, 1, TEST, 0), row(11, 1, TEST, 502)], 501, 99)).toEqual([]);
  });

  it("leaves out the asking process and its ancestors, wherever they sit", () => {
    const rows = [row(10, 1, TEST), row(20, 10, "zsh"), row(30, 20, TEST), row(99, 30, TEST), row(40, 1, TEST)];
    expect(runningUiTestPids(rows, 501, 99)).toEqual([40]);
  });

  it("lists nothing for an empty table", () => {
    expect(runningUiTestPids([], 501, 99)).toEqual([]);
  });
});


// Issue #324 review: Xcode.app (Cmd-U) spawns no build-tool process, so a run it drives shows as its test runner: a UI-test runner app (an executable under a
// `*-Runner.app/` bundle), or an `xctest` process that Xcode.app owns or that runs from a simulator platform or runtime. A bare `xctest` is not one: the
// PhaseMatrix gate runs `xcrun xctest <bundle>.xctest` for every XCTest bundle, nearly all day.
describe("isTestRunnerProcess", () => {
  const APP = "/Users/x/Library/Developer/CoreSimulator/Devices/5E2F590B-1111-4222-8333-444455556666/data/Containers/Bundle/Application/ABC123";
  it.each<[string, string]>([
    ["a UI-test runner in a simulator container", `${APP}/AppUITests-Runner.app/AppUITests-Runner`],
    ["a runner built in DerivedData", "/Users/x/Library/Developer/Xcode/DerivedData/App-abcdef/Build/Products/Debug-iphonesimulator/AppUITests-Runner.app/AppUITests-Runner"],
    ["a runner under a path with spaces in an .app", "/Applications/My Tools.app/Contents/Build/AppUITests-Runner.app/AppUITests-Runner"],
    ["a macOS runner with arguments", "/x/Build/Products/Debug/AppUITests-Runner.app/Contents/MacOS/AppUITests-Runner -NSDocumentRevisionsDebugMode YES"],
  ])("is true for %s", (_name, command) => {
    expect(isTestRunnerProcess(command)).toBe(true);
  });

  it.each<[string, string]>([
    ["an app that is not a runner", `${APP}/App.app/App`],
    ["a name that only ends in Runner", `${APP}/GameRunner.app/GameRunner`],
    ["a path component that merely mentions it", "/usr/bin/grep -r -Runner.app/ /x"],
    ["a shell script that holds the words", "/bin/zsh -c open AppUITests-Runner.app/AppUITests-Runner"],
    ["xctest, which is not a runner app", "/Applications/Xcode.app/Contents/Developer/usr/bin/xctest /x/AppTests.xctest"],
    ["an empty command", ""],
  ])("is false for %s", (_name, command) => {
    expect(isTestRunnerProcess(command)).toBe(false);
  });
});

describe("isXctestProcess", () => {
  it.each<[string, string]>([
    ["by Xcode path", "/Applications/Xcode.app/Contents/Developer/usr/bin/xctest /x/AppTests.xctest"],
    ["by name", "xctest -XCTest All /x/AppTests.xctest"],
    ["in a simulator platform", "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest -XCTestBundlePath x"],
  ])("is true for %s", (_name, command) => {
    expect(isXctestProcess(command)).toBe(true);
  });
  it.each<[string, string]>([
    ["a tool whose name contains xctest", "/usr/bin/xctestrun-tool run"],
    ["a similar name", "myxctest run"],
    ["a shell that holds the words", "/bin/zsh -c xcrun xctest Foo.xctest"],
    ["an empty command", ""],
  ])("is false for %s", (_name, command) => {
    expect(isXctestProcess(command)).toBe(false);
  });
});

describe("hasXcodeAppAncestor", () => {
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, pgid: pid, uid: 501, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  const XCODE = "/Applications/Xcode.app/Contents/MacOS/Xcode";
  it.each<[string, string]>([
    ["Xcode.app", XCODE],
    ["a beta Xcode.app", "/Applications/Xcode-beta.app/Contents/MacOS/Xcode"],
    ["Xcode.app in a path with spaces", "/Applications/Xcode Beta 2.app/Contents/MacOS/Xcode"],
    ["Xcode.app with arguments", `${XCODE} -NSDocumentRevisionsDebugMode YES`],
  ])("finds %s two levels up", (_name, xcode) => {
    expect(hasXcodeAppAncestor([row(1000, 1, xcode), row(1001, 1000, "helper"), row(1002, 1001, "xctest")], 1002)).toBe(true);
  });
  it.each<[string, string]>([
    ["a shell that only names it", `/bin/zsh -c open ${XCODE}`],
    ["another app's main executable", "/Applications/Safari.app/Contents/MacOS/Safari"],
    ["Xcode's helper, not its main executable", "/Applications/Xcode.app/Contents/SharedFrameworks/XcodeHelper"],
    ["a name that only contains Xcode", "/Applications/NotXcode.app/Contents/MacOS/NotXcode"],
    ["another app whose executable is named Xcode", "/Applications/Other.app/Contents/MacOS/Xcode"],
    ["an executable whose name only starts with Xcode", "/Applications/Xcode.app/Contents/MacOS/XcodeHelper"],
  ])("does not find %s", (_name, command) => {
    expect(hasXcodeAppAncestor([row(1000, 1, command), row(1002, 1000, "xctest")], 1002)).toBe(false);
  });
  it("looks only at ancestors, not at the process itself or at unrelated rows", () => {
    expect(hasXcodeAppAncestor([row(1002, 1, XCODE), row(1003, 1, "xctest")], 1003)).toBe(false);
    expect(hasXcodeAppAncestor([row(1002, 1, XCODE)], 1002)).toBe(false);
  });
});

describe("runningUiTestPids and a test runner", () => {
  const row = (pid: number, ppid: number, command: string, uid = 501) => ({ pid, ppid, pgid: pid, uid, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  const XCODE = "/Applications/Xcode.app/Contents/MacOS/Xcode";
  const XCTEST = "/Applications/Xcode.app/Contents/Developer/usr/bin/xctest /x/T.xctest";
  const RUNNER = "/x/AppUITests-Runner.app/AppUITests-Runner";
  const SIM_XCTEST = "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest -XCTestBundlePath x";

  // Issue #324 review: a runner or simulator-path xctest that the build tool drives is already covered by the build tool's own process, and one left
  // behind by a killed run would otherwise wedge the UI class for good, so they count only while Xcode.app's main executable is running.
  it("counts a runner app of this user only while Xcode.app is running, and not another user's, and not the asking process's ancestry", () => {
    const runners = [row(10, 1, RUNNER), row(12, 1, RUNNER, 0), row(20, 1, RUNNER), row(99, 20, "wrapper")];
    expect(runningUiTestPids([...runners, row(40, 1, XCODE)], 501, 99)).toEqual([10]);
    expect(runningUiTestPids(runners, 501, 99)).toEqual([]);
  });

  it("does not count a leftover runner under a launchd_sim with no Xcode.app", () => {
    const rows = [row(5, 1, "/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/U/data/x"), row(10, 5, RUNNER)];
    expect(runningUiTestPids(rows, 501, 99)).toEqual([]);
  });

  it("does not count Xcode.app of another user, or a process that only names it", () => {
    expect(runningUiTestPids([row(10, 1, RUNNER), row(40, 1, XCODE, 0)], 501, 99)).toEqual([]);
    expect(runningUiTestPids([row(10, 1, RUNNER), row(40, 1, `/bin/zsh -c open ${XCODE}`)], 501, 99)).toEqual([]);
  });

  // Issue #324 review: `xcrun xctest <bundle>` is what a Swift gate runs, so a bare xctest says nothing about a UI run.
  it("does not count an xctest run by a shell under a heavy-queue or perl wrapper, or from a plain terminal", () => {
    const rows = [row(10, 1, "perl /x/heavy-queue run --shell xcrun xctest Foo.xctest"), row(11, 10, "/bin/sh -c xcrun xctest Foo.xctest"), row(12, 11, XCTEST), row(13, 1, "xctest Foo.xctest"), row(14, 1, "/bin/zsh"), row(15, 14, XCTEST)];
    expect(runningUiTestPids(rows, 501, 99)).toEqual([]);
  });

  it("counts an xctest that has Xcode.app among its ancestors", () => {
    const rows = [row(20, 1, XCODE), row(21, 20, "/Applications/Xcode.app/Contents/Developer/usr/libexec/testmanagerd"), row(22, 21, XCTEST), row(23, 1, XCTEST)];
    expect(runningUiTestPids(rows, 501, 99)).toEqual([22]);
  });

  it.each<[string, string]>([
    ["an iPhone simulator platform agent", SIM_XCTEST],
    ["another simulator platform", SIM_XCTEST.replace("iPhoneSimulator", "AppleTVSimulator")],
    ["a simulator runtime agent", "/Library/Developer/CoreSimulator/Volumes/iOS_23A/Library/Developer/CoreSimulator/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot/Developer/Library/Xcode/Agents/xctest -XCTestBundlePath x"],
  ])("counts an xctest that runs from %s while Xcode.app is running, wherever its parent is, and not without it", (_name, command) => {
    expect(runningUiTestPids([row(30, 1, command), row(40, 1, XCODE)], 501, 99)).toEqual([30]);
    expect(runningUiTestPids([row(30, 1, command)], 501, 99)).toEqual([]);
  });

  it("does not count an xctest whose path only mentions a simulator in an argument", () => {
    expect(runningUiTestPids([row(31, 1, "xctest /x/iPhoneSimulator.platform/T.xctest"), row(40, 1, XCODE)], 501, 99)).toEqual([]);
  });

  it("leaves another user's xctest out, even under Xcode.app", () => {
    const rows = [row(20, 1, XCODE), row(21, 20, XCTEST, 0)];
    expect(runningUiTestPids(rows, 501, 99)).toEqual([]);
  });

  it("still counts a build tool test action with no Xcode.app", () => {
    expect(runningUiTestPids([row(50, 1, "xcodebuild test -scheme App")], 501, 99)).toEqual([50]);
  });
});

// Issue #324 review: a runner left behind by a killed run, on a device that is gone, is a leftover and not a test in progress; with Xcode.app open it would
// otherwise withhold the UI slot for good. The scan cannot call `simctl` cheaply, so a device is gone when no `launchd_sim` of its UDID is in the same table.
describe("runningUiTestPids and a leftover runner", () => {
  const row = (pid: number, ppid: number, command: string, uid = 501) => ({ pid, ppid, pgid: pid, uid, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  const XCODE = "/Applications/Xcode.app/Contents/MacOS/Xcode";
  const U1 = "5E2F590B-1111-4222-8333-444455556666";
  const U2 = "9F8E7D6C-1111-4222-8333-444455556666";
  const runnerOn = (udid: string, dir = "CoreSimulator/Devices") => `/Users/x/Library/Developer/${dir}/${udid}/data/Containers/Bundle/Application/ABC/AppUITests-Runner.app/AppUITests-Runner`;
  const launchd = (pid: number, udid: string, dir = "CoreSimulator/Devices") => row(pid, 1, `/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim /Users/x/Library/Developer/${dir}/${udid}/data/x`);
  const SIM_XCTEST = "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest -XCTestBundlePath x";

  it("does not count a runner whose device has no launchd_sim in the table, with Xcode.app running", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), row(10, 1, runnerOn(U1))], 501, 99)).toEqual([]);
  });

  it("does not count a runner on a test clone whose device has no launchd_sim", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), row(10, 1, runnerOn(U1, "XCTestDevices"))], 501, 99)).toEqual([]);
  });

  it.each<[string, string]>([
    ["its device's launchd_sim", "CoreSimulator/Devices"],
    ["its test clone's launchd_sim", "XCTestDevices"],
  ])("counts a runner while %s is alive", (_name, dir) => {
    expect(runningUiTestPids([row(40, 1, XCODE), launchd(5, U1, dir), row(10, 5, runnerOn(U1, dir))], 501, 99)).toEqual([10]);
  });

  it("counts a runner whose device has a launchd_sim written in another case", () => {
    const lower = row(5, 1, `/x/sbin/launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${U1.toLowerCase()}/data/x`);
    expect(runningUiTestPids([row(40, 1, XCODE), lower, row(10, 5, runnerOn(U1))], 501, 99)).toEqual([10]);
  });

  it("does not take another device's launchd_sim for its device's", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), launchd(5, U2), row(10, 1, runnerOn(U1))], 501, 99)).toEqual([]);
  });

  it("does not take a process that only names launchd_sim for one", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), row(5, 1, `grep launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${U1}/data/x`), row(10, 1, runnerOn(U1))], 501, 99)).toEqual([10]);
  });

  it("keeps counting a runner whose command names no device", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), row(10, 1, "/x/Build/Products/Debug/AppUITests-Runner.app/AppUITests-Runner")], 501, 99)).toEqual([10]);
  });

  it("counts a leftover runner that a build tool test action stands beside as that action, not as the runner", () => {
    expect(runningUiTestPids([row(40, 1, XCODE), row(10, 1, runnerOn(U1)), row(11, 1, "xcodebuild test -scheme App")], 501, 99)).toEqual([11]);
  });

  describe("and a simulator xctest with no device in its path, by its environment", () => {
    const udids = (map: Record<number, string>) => (pids: number[]) => new Map(pids.flatMap((p) => (p in map ? [[p, map[p]!] as [number, string]] : [])));

    it("does not count one whose environment names a device with no launchd_sim", () => {
      expect(runningUiTestPids([row(40, 1, XCODE), row(30, 1, SIM_XCTEST)], 501, 99, udids({ 30: U1 }))).toEqual([]);
    });

    it("counts one whose environment names a device that has a launchd_sim", () => {
      expect(runningUiTestPids([row(40, 1, XCODE), launchd(5, U1), row(30, 5, SIM_XCTEST)], 501, 99, udids({ 30: U1 }))).toEqual([30]);
    });

    it.each<[string, ((pids: number[]) => Map<number, string>) | undefined]>([
      ["names no device", udids({})],
      ["cannot be read (the lookup throws)", () => { throw new Error("ps timed out"); }],
      ["is not looked up (no reader)", undefined],
    ])("keeps counting one whose environment %s", (_name, reader) => {
      expect(runningUiTestPids([row(40, 1, XCODE), row(30, 1, SIM_XCTEST)], 501, 99, reader)).toEqual([30]);
    });

    it("asks for the environment of the candidates with no device in their path, once, and of nobody else", () => {
      const asked: number[][] = [];
      const reader = (pids: number[]) => (asked.push(pids), new Map<number, string>());
      runningUiTestPids([row(40, 1, XCODE), row(30, 1, SIM_XCTEST), row(10, 1, runnerOn(U1)), row(11, 1, "/x/Build/AppUITests-Runner.app/AppUITests-Runner"), row(12, 1, "xcodebuild test -scheme A")], 501, 99, reader);
      expect(asked).toEqual([[30, 11]]);
      asked.length = 0;
      runningUiTestPids([row(40, 1, XCODE), row(10, 1, runnerOn(U1))], 501, 99, reader);
      expect(asked).toEqual([]);
    });

    it("does not ask without Xcode.app: nothing but a build tool test action counts then", () => {
      const asked: number[][] = [];
      runningUiTestPids([row(30, 1, SIM_XCTEST)], 501, 99, (pids) => (asked.push(pids), new Map()));
      expect(asked).toEqual([]);
    });

    it("counts an xctest that has Xcode.app among its ancestors whatever its device", () => {
      expect(runningUiTestPids([row(40, 1, XCODE), row(31, 40, "/Applications/Xcode.app/Contents/Developer/usr/bin/xctest /x/T.xctest")], 501, 99, udids({ 31: U1 }))).toEqual([31]);
    });
  });
});

describe("xcodeAppRunning", () => {
  const row = (pid: number, command: string, uid = 501) => ({ pid, ppid: 1, pgid: pid, uid, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  it("is true for this user's Xcode.app main executable and false for anything else", () => {
    expect(xcodeAppRunning([row(1, "/Applications/Xcode.app/Contents/MacOS/Xcode")], 501)).toBe(true);
    expect(xcodeAppRunning([row(1, "/Applications/Xcode Beta 2.app/Contents/MacOS/Xcode -x")], 501)).toBe(true);
    expect(xcodeAppRunning([row(1, "/Applications/Xcode.app/Contents/MacOS/Xcode", 0)], 501)).toBe(false);
    expect(xcodeAppRunning([row(1, "/bin/zsh -c open /Applications/Xcode.app/Contents/MacOS/Xcode")], 501)).toBe(false);
    expect(xcodeAppRunning([], 501)).toBe(false);
  });
});

// Issue #324 review: the watchdog's hung report covers every kind of test in progress, including a runner or xctest the scan would not count (no Xcode.app).
describe("hungTestCandidates", () => {
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, pgid: pid, uid: 501, stat: "S", elapsedMs: 0, rssBytes: 0, command });
  const RUNNER = "/x/AppUITests-Runner.app/AppUITests-Runner";
  it("lists build tool test actions, runners, and xctest under Xcode.app or from a simulator path, with or without Xcode.app running", () => {
    const rows = [
      row(10, 1, "xcodebuild test -scheme A"),
      row(11, 1, RUNNER),
      row(12, 1, "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest x"),
      row(20, 1, "/Applications/Xcode.app/Contents/MacOS/Xcode"),
      row(21, 20, "xctest /x/T.xctest"),
      row(30, 1, "xcodebuild build -scheme A"),
      row(31, 1, "xctest /x/T.xctest"),
      row(32, 1, "/bin/zsh"),
    ];
    expect(hungTestCandidates(rows).map((r) => r.pid)).toEqual([10, 11, 12, 21]);
  });
});

describe("isBuildToolProcess", () => {
  it.each<[string, string]>([
    ["the build tool by name", "xcodebuild -showBuildSettings"],
    ["simctl through xcrun", "xcrun simctl list"],
    ["simctl through a qualified xcrun", "/usr/bin/xcrun simctl shutdown U"],
    ["simctl by path", "/Applications/Xcode.app/Contents/Developer/usr/bin/simctl list"],
    ["the build tool in an Xcode path with spaces", "/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/xcodebuild test"],
    ["the build tool alone", "xcodebuild"],
  ])("is true for %s", (_name, command) => {
    expect(isBuildToolProcess(command)).toBe(true);
  });
  it.each<[string, string]>([
    ["a claude session whose prompt names the build tool", "claude -p run xcodebuild test -scheme App and then simctl list"],
    ["a shell script that holds the words", "/bin/zsh -c xcodebuild test"],
    ["a grep for the words", "grep -rn simctl docs"],
    ["a similar name", "myxcodebuild test"],
    ["a longer name with the same start", "xcodebuilder test"],
    ["a longer simctl name", "simctlx list"],
    ["an empty command", ""],
  ])("is false for %s", (_name, command) => {
    expect(isBuildToolProcess(command)).toBe(false);
  });
});

describe("XCODEBUILD_VALUED", () => {
  it("is the one table of the build tool's options that take a value, shared by the hook's classifier and the process classifier", () => {
    for (const option of ["scheme", "project", "destination", "xctestrun", "only-testing"]) expect(XCODEBUILD_VALUED.test(`-${option}`)).toBe(true);
    for (const flag of ["retry-tests-on-failure", "quiet", "enumerate-tests"]) expect(XCODEBUILD_VALUED.test(`-${flag}`)).toBe(false);
  });
});
