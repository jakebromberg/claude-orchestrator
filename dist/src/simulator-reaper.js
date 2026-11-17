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
 *   Not while Xcode.app runs or anything but the clone's system runtime is in its tree or names it (a test runner, an app): Xcode.app drives
 *   CoreSimulator without spawning `xcodebuild` or `simctl`, so a clone its parallel test run uses looks idle.
 *   A device of the main set (`~/Library/Developer/CoreSimulator/Devices`) is never shut down for being idle: the owner uses those by hand
 *   in Simulator.app, where no `xcodebuild` or `simctl` running says nothing about use.
 *
 * Nothing is touched while any `xcodebuild` test action runs on the machine or a tool of the build chain names the device, and nothing for a
 * set whose device list cannot be read. Every action is one `simulator-reap` line in `events.jsonl`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ancestry, isSimulatorCommand, parsePsTable, PS_TABLE_ARGS, runsTool, XCODE_TOOLS } from "./ps.js";
/** The bound on every `simctl` and `ps` call here: `simctl` can hang. */
export const SIMCTL_TIMEOUT_MS = 30_000;
const UDID = "[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
const ENV_UDID = new RegExp(`^\\s*(\\d+)\\s.*?\\bSIMULATOR_UDID=(${UDID})\\b`);
const isTestAction = (command) => runsTool(command, ["xcodebuild"]) && /\s(?:test|test-without-building)(?=\s|$)/.test(command);
/** The Xcode.app process itself: it drives CoreSimulator (parallel test clones included) without spawning `xcodebuild` or `simctl`. */
const XCODE_APP = /\/Contents\/MacOS\/Xcode(?:\s|$)/;
/** A daemon of the simulator's own system runtime; the test agents it ships live under `RuntimeRoot/Developer` and are not system. */
const isSystemRuntime = (command) => command.includes("/RuntimeRoot/") && !command.includes("/RuntimeRoot/Developer/");
/**
 * Whether a test clone may be in use although no `xcodebuild` or `simctl` runs: Xcode.app is running (its window may be driving the clone), or any
 * process besides the clone's system runtime is in the clone's tree (a descendant of its `launchd_sim`: a test runner, an app) or names its UDID in
 * its command line (an app under `XCTestDevices/<udid>/data/Containers`, a tool given the device).
 */
const cloneRoot = (procs, udid) => procs.find((p) => p.command.includes("launchd_sim") && p.command.toUpperCase().includes(`/XCTESTDEVICES/${udid.toUpperCase()}/`));
function cloneMayBeInUse(procs, udid) {
    if (procs.some((p) => XCODE_APP.test(p.command)))
        return true;
    const key = udid.toUpperCase();
    const root = cloneRoot(procs, udid);
    return procs.some((p) => p !== root && !isSystemRuntime(p.command) && (p.command.toUpperCase().includes(key) || (root !== undefined && ancestry(procs, p.pid, 64).chain.some((r) => r.pid === root.pid))));
}
/** Device UDID → state from `simctl list devices -j` for one set. Throws on text that is not that shape. */
function deviceStates(text) {
    const { devices } = JSON.parse(text);
    return new Map(Object.values(devices).flatMap((list) => list.map((d) => [d.udid.toUpperCase(), d.state])));
}
/** The set a device lives in, from the device-data path in a runtime process's environment (its `HOME` is `<set>/<udid>/data`); `undefined` for any other set (SwiftUI Previews, Playgrounds), which is left alone entirely. */
function deviceSetOf(envLine, udid) {
    const text = envLine.toUpperCase();
    if (text.includes(`/CORESIMULATOR/DEVICES/${udid}/`))
        return "main";
    if (text.includes(`/XCTESTDEVICES/${udid}/`))
        return "xctest";
    return undefined;
}
/** This user's simulator runtime processes whose environment names a device of a set the reaper handles, grouped by device. */
function runtimeDevices(procs, deps) {
    const pids = procs.filter((p) => p.uid === deps.uid && isSimulatorCommand(p.command)).map((p) => p.pid);
    const byDevice = new Map();
    if (pids.length === 0)
        return byDevice;
    for (const line of deps.processEnv(pids).split("\n")) {
        const m = ENV_UDID.exec(line);
        const udid = m?.[2].toUpperCase();
        const set = udid && deviceSetOf(line, udid);
        if (!udid || !set)
            continue;
        const key = `${set}:${udid}`;
        byDevice.set(key, { udid, set, pids: [...(byDevice.get(key)?.pids ?? []), Number(m[1])] });
    }
    return byDevice;
}
/**
 * Runs one cycle and returns the attempts to carry to the next: only devices that still have leftovers. Never throws. A device is acted on
 * only when the list of its own set explicitly reports it `Shutdown` (or, for the idle shutdown, an XCTestDevices clone `Booted`): `simctl
 * list` covers one set, so a device it does not name, an empty list and an unreadable one all mean unknown, and nothing is done.
 */
export function reapSimulators({ procs, idleUdids, attempts, seen }, deps) {
    if (procs.some((p) => isTestAction(p.command)))
        return { attempts, seen };
    // Nothing of this user's is running in a simulator and no device is idle: there is nothing to decide, so no `simctl` is spawned.
    if (idleUdids.length === 0 && !procs.some((p) => p.uid === deps.uid && isSimulatorCommand(p.command)))
        return { attempts: {}, seen: {} };
    const states = {};
    for (const set of ["main", "xctest"]) {
        try {
            states[set] = deviceStates(deps.listDevices(set));
        }
        catch {
            // That set's devices are unknown this cycle.
        }
    }
    let leftovers;
    try {
        leftovers = runtimeDevices(procs, deps);
    }
    catch {
        return { attempts, seen };
    }
    const inUseIn = (table, udid) => table.some((p) => runsTool(p.command, XCODE_TOOLS) && p.command.toUpperCase().includes(udid));
    const inUse = (udid) => inUseIn(procs, udid);
    /** The table right before an action, once per action; `undefined` when it cannot be read or a test action runs in it, so nothing is done. */
    const freshTable = () => {
        try {
            const table = deps.scan();
            return table.some((p) => isTestAction(p.command)) ? undefined : table;
        }
        catch {
            return undefined;
        }
    };
    const next = {};
    const nextSeen = {};
    for (const { udid, set, pids } of leftovers.values()) {
        const state = states[set]?.get(udid);
        if (state !== "Shutdown" || inUse(udid)) {
            // Unknown this cycle (its list unreadable, or a tool is using it): what was known stays; a device that reads otherwise starts over.
            if (states[set] === undefined || inUse(udid)) {
                if (attempts[udid] !== undefined)
                    next[udid] = attempts[udid];
                if (seen[udid] !== undefined)
                    nextSeen[udid] = seen[udid];
            }
            continue;
        }
        // One reading of Shutdown is not enough: only the pids the previous cycle saw for this device are signalled, and the rest are recorded.
        nextSeen[udid] = pids;
        const confirmedPids = pids.filter((pid) => seen[udid]?.includes(pid));
        if (confirmedPids.length === 0) {
            if (attempts[udid] !== undefined)
                next[udid] = attempts[udid];
            continue;
        }
        // The decision was made on an older scan: read the table again for this device's batch and apply the guards to it, signalling only the pids
        // still there as a simulator process of this user. Nothing is done, and what was known stays, when it cannot be read or a guard now holds.
        const fresh = freshTable();
        const present = fresh && !inUseIn(fresh, udid) ? confirmedPids.filter((pid) => fresh.some((p) => p.pid === pid && p.uid === deps.uid && isSimulatorCommand(p.command))) : [];
        if (present.length === 0) {
            if (attempts[udid] !== undefined)
                next[udid] = attempts[udid];
            nextSeen[udid] = pids;
            continue;
        }
        const attempt = (attempts[udid] ?? 0) + 1;
        next[udid] = attempt;
        const [signal, action] = attempt >= 2 ? ["SIGKILL", "kill"] : ["SIGTERM", "terminate"];
        const done = [];
        const failed = [];
        for (const pid of present) {
            try {
                deps.signal(pid, signal);
                done.push(pid);
            }
            catch (err) {
                failed.push({ pid, message: err.message });
            }
        }
        if (done.length > 0)
            deps.log({ type: "simulator-reap", udid, reason: "shutdown-leftovers", action, pids: done, ok: true });
        for (const { pid, message } of failed)
            deps.log({ type: "simulator-reap", udid, reason: "shutdown-leftovers", action, pids: [pid], ok: false, message });
    }
    for (const udid of idleUdids) {
        if (states.xctest?.get(udid.toUpperCase()) !== "Booted" || inUse(udid) || cloneMayBeInUse(procs, udid))
            continue;
        // Read the table again for this clone: Xcode.app, a test run or a runner may have started since the decision, and the clone may be gone.
        const fresh = freshTable();
        if (!fresh || !cloneRoot(fresh, udid) || inUseIn(fresh, udid) || cloneMayBeInUse(fresh, udid))
            continue;
        try {
            deps.shutdown(udid, "xctest");
            deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: true });
        }
        catch (err) {
            deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: false, message: err.message });
        }
    }
    return { attempts: next, seen: nextSeen };
}
/** `ps -p` exits 1 when a listed pid is gone by the time it runs but prints the rest, so the rows of a status-1 exit with output are the answer; any other failure throws. */
function psRows(exec, args) {
    try {
        return exec("ps", args, SIMCTL_TIMEOUT_MS);
    }
    catch (err) {
        const { status, stdout } = err;
        if (status === 1 && typeof stdout === "string" && stdout.length > 0)
            return stdout;
        throw err;
    }
}
const execBounded = (file, args, timeoutMs) => execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
/** The real seams: `xcrun simctl`, `ps -E` and `process.kill`, each external call bounded by `SIMCTL_TIMEOUT_MS`; `exec`, `uid`, `testSetDir` and `exists` are test seams. A test set that does not exist lists no devices. */
export function realReaperDeps({ log, exec = execBounded, uid = process.getuid(), testSetDir = join(homedir(), "Library", "Developer", "XCTestDevices"), exists = existsSync, }) {
    const setArgs = (set) => (set === "main" ? [] : ["--set", testSetDir]);
    return {
        listDevices: (set) => (set === "xctest" && !exists(testSetDir) ? '{"devices":{}}' : exec("xcrun", ["simctl", ...setArgs(set), "list", "devices", "-j"], SIMCTL_TIMEOUT_MS)),
        scan: () => parsePsTable(exec("ps", PS_TABLE_ARGS, SIMCTL_TIMEOUT_MS)),
        processEnv: (pids) => (pids.length === 0 ? "" : psRows(exec, ["-Eww", "-p", pids.join(","), "-o", "pid=,command="])),
        shutdown: (udid, set) => void exec("xcrun", ["simctl", ...setArgs(set), "shutdown", udid], SIMCTL_TIMEOUT_MS),
        signal: (pid, signal) => void process.kill(pid, signal),
        log,
        uid,
    };
}
//# sourceMappingURL=simulator-reaper.js.map