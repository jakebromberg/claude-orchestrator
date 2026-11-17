/**
 * Reaps what a simulator run leaves behind, for the watchdog bin (`cli-watchdog.ts`; `watchdog.ts` itself sends no signal and takes this as
 * its optional `reap` dependency). Two cases, both for this user's own processes only:
 *
 * - A device that the list of its own set explicitly reports `Shutdown` and that still has runtime processes, found by `SIMULATOR_UDID` in
 *   their environment, the set by the device-data path in it (the main set or the XCTestDevices set; any other set is left alone): they
 *   are sent SIGTERM, and SIGKILL once they have outlived a cycle. A device the list does not name is unknown, never reaped. A killed test run leaves these behind with their
 *   `launchd_sim` gone, so nothing else would ever stop them.
 * - A test clone, a device of the XCTestDevices set that only `xcodebuild` creates, that is `Booted` and idle past the watchdog's threshold:
 *   `simctl --set <that set> shutdown`, bounded. Its processes exit with it, and any that do not are the first case from the next cycle.
 *   A device of the main set (`~/Library/Developer/CoreSimulator/Devices`) is never shut down for being idle: the owner uses those by hand
 *   in Simulator.app, where no `xcodebuild` or `simctl` running says nothing about use.
 *
 * Nothing is touched while any `xcodebuild` test action runs on the machine or a tool of the build chain names the device, and nothing at
 * all when the device list cannot be read. Every action is one `simulator-reap` line in `events.jsonl`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSimulatorCommand, runsTool, XCODE_TOOLS, type ProcRow } from "./ps.js";

/** The bound on every `simctl` and `ps` call here: `simctl` can hang. */
export const SIMCTL_TIMEOUT_MS = 30_000;

export interface SimulatorReapEvent {
  type: "simulator-reap";
  udid: string;
  reason: "shutdown-leftovers" | "booted-idle";
  action: "shutdown" | "terminate" | "kill";
  /** The processes the action was for or, with `ok` false, the one that failed. */
  pids?: number[];
  ok: boolean;
  /** The failure, when `ok` is false. */
  message?: string;
}

/** `main` is `~/Library/Developer/CoreSimulator/Devices`; `xctest` is the test clones' set, `~/Library/Developer/XCTestDevices`. */
export type DeviceSet = "main" | "xctest";

export interface ReaperDeps {
  /** `simctl list devices -j` for a device set; throws when it fails or times out. */
  listDevices(set: DeviceSet): string;
  /** `ps -E` for the given pids, one `pid command environment` line each. */
  processEnv(pids: number[]): string;
  /** `simctl shutdown <udid>` in the device's set; throws when it fails or times out. */
  shutdown(udid: string, set: DeviceSet): void;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  log(event: SimulatorReapEvent): void;
  /** Only processes of this user are signalled. */
  uid: number;
}

export interface ReapInput {
  procs: ProcRow[];
  /** Booted devices with no `xcodebuild` or `simctl` running for the watchdog's idle threshold; only those of the `xctest` set are shut down. */
  idleUdids: string[];
  /** Cycles each device's leftovers have been signalled so far, from the last cycle. */
  attempts: Record<string, number>;
}

const UDID = "[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
const ENV_UDID = new RegExp(`^\\s*(\\d+)\\s.*?\\bSIMULATOR_UDID=(${UDID})\\b`);

const isTestAction = (command: string): boolean => runsTool(command, ["xcodebuild"]) && /\s(?:test|test-without-building)(?=\s|$)/.test(command);

/** Device UDID → state from `simctl list devices -j` for one set. Throws on text that is not that shape. */
function deviceStates(text: string): Map<string, string> {
  const { devices } = JSON.parse(text) as { devices: Record<string, { udid: string; state: string }[]> };
  return new Map(Object.values(devices).flatMap((list) => list.map((d) => [d.udid.toUpperCase(), d.state] as const)));
}

/** The set a device lives in, from the device-data path in a runtime process's environment (its `HOME` is `<set>/<udid>/data`); `undefined` for any other set (SwiftUI Previews, Playgrounds), which is left alone entirely. */
function deviceSetOf(envLine: string, udid: string): DeviceSet | undefined {
  const text = envLine.toUpperCase();
  if (text.includes(`/CORESIMULATOR/DEVICES/${udid}/`)) return "main";
  if (text.includes(`/XCTESTDEVICES/${udid}/`)) return "xctest";
  return undefined;
}

/** This user's simulator runtime processes whose environment names a device of a set the reaper handles, grouped by device. */
function runtimeDevices(procs: ProcRow[], deps: ReaperDeps): Map<string, { udid: string; set: DeviceSet; pids: number[] }> {
  const pids = procs.filter((p) => p.uid === deps.uid && isSimulatorCommand(p.command)).map((p) => p.pid);
  const byDevice = new Map<string, { udid: string; set: DeviceSet; pids: number[] }>();
  if (pids.length === 0) return byDevice;
  for (const line of deps.processEnv(pids).split("\n")) {
    const m = ENV_UDID.exec(line);
    const udid = m?.[2]!.toUpperCase();
    const set = udid && deviceSetOf(line, udid);
    if (!udid || !set) continue;
    const key = `${set}:${udid}`;
    byDevice.set(key, { udid, set, pids: [...(byDevice.get(key)?.pids ?? []), Number(m![1])] });
  }
  return byDevice;
}

/**
 * Runs one cycle and returns the attempts to carry to the next: only devices that still have leftovers. Never throws. A device is acted on
 * only when the list of its own set explicitly reports it `Shutdown` (or, for the idle shutdown, an XCTestDevices clone `Booted`): `simctl
 * list` covers one set, so a device it does not name, an empty list and an unreadable one all mean unknown, and nothing is done.
 */
export function reapSimulators({ procs, idleUdids, attempts }: ReapInput, deps: ReaperDeps): Record<string, number> {
  if (procs.some((p) => isTestAction(p.command))) return attempts;
  const states: Partial<Record<DeviceSet, Map<string, string>>> = {};
  for (const set of ["main", "xctest"] as const) {
    try {
      states[set] = deviceStates(deps.listDevices(set));
    } catch {
      // That set's devices are unknown this cycle.
    }
  }
  let leftovers: ReturnType<typeof runtimeDevices>;
  try {
    leftovers = runtimeDevices(procs, deps);
  } catch {
    return attempts;
  }
  const inUse = (udid: string): boolean => procs.some((p) => runsTool(p.command, XCODE_TOOLS) && p.command.toUpperCase().includes(udid));
  const next: Record<string, number> = {};
  for (const { udid, set, pids } of leftovers.values()) {
    const state = states[set]?.get(udid);
    if (state !== "Shutdown" || inUse(udid)) {
      if (attempts[udid] !== undefined && (states[set] === undefined || inUse(udid))) next[udid] = attempts[udid]!;
      continue;
    }
    const attempt = (attempts[udid] ?? 0) + 1;
    next[udid] = attempt;
    const [signal, action] = attempt >= 2 ? (["SIGKILL", "kill"] as const) : (["SIGTERM", "terminate"] as const);
    const done: number[] = [];
    const failed: { pid: number; message: string }[] = [];
    for (const pid of pids) {
      try {
        deps.signal(pid, signal);
        done.push(pid);
      } catch (err) {
        failed.push({ pid, message: (err as Error).message });
      }
    }
    if (done.length > 0) deps.log({ type: "simulator-reap", udid, reason: "shutdown-leftovers", action, pids: done, ok: true });
    for (const { pid, message } of failed) deps.log({ type: "simulator-reap", udid, reason: "shutdown-leftovers", action, pids: [pid], ok: false, message });
  }
  for (const udid of idleUdids) {
    if (states.xctest?.get(udid.toUpperCase()) !== "Booted" || inUse(udid)) continue;
    try {
      deps.shutdown(udid, "xctest");
      deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: true });
    } catch (err) {
      deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: false, message: (err as Error).message });
    }
  }
  return next;
}

/** `ps -p` exits 1 when a listed pid is gone by the time it runs but prints the rest, so the rows of a status-1 exit with output are the answer; any other failure throws. */
function psRows(exec: (file: string, args: string[], timeoutMs: number) => string, args: string[]): string {
  try {
    return exec("ps", args, SIMCTL_TIMEOUT_MS);
  } catch (err) {
    const { status, stdout } = err as { status?: unknown; stdout?: unknown };
    if (status === 1 && typeof stdout === "string" && stdout.length > 0) return stdout;
    throw err;
  }
}

const execBounded = (file: string, args: string[], timeoutMs: number): string =>
  execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/** The real seams: `xcrun simctl`, `ps -E` and `process.kill`, each external call bounded by `SIMCTL_TIMEOUT_MS`; `exec`, `uid`, `testSetDir` and `exists` are test seams. A test set that does not exist lists no devices. */
export function realReaperDeps({
  log,
  exec = execBounded,
  uid = process.getuid!(),
  testSetDir = join(homedir(), "Library", "Developer", "XCTestDevices"),
  exists = existsSync,
}: {
  log: ReaperDeps["log"];
  exec?: (file: string, args: string[], timeoutMs: number) => string;
  uid?: number;
  testSetDir?: string;
  exists?: (dir: string) => boolean;
}): ReaperDeps {
  const setArgs = (set: DeviceSet): string[] => (set === "main" ? [] : ["--set", testSetDir]);
  return {
    listDevices: (set) => (set === "xctest" && !exists(testSetDir) ? '{"devices":{}}' : exec("xcrun", ["simctl", ...setArgs(set), "list", "devices", "-j"], SIMCTL_TIMEOUT_MS)),
    processEnv: (pids) => (pids.length === 0 ? "" : psRows(exec, ["-Eww", "-p", pids.join(","), "-o", "pid=,command="])),
    shutdown: (udid, set) => void exec("xcrun", ["simctl", ...setArgs(set), "shutdown", udid], SIMCTL_TIMEOUT_MS),
    signal: (pid, signal) => void process.kill(pid, signal),
    log,
    uid,
  };
}
