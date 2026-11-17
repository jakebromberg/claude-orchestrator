/**
 * Reaps what a simulator run leaves behind, for the watchdog bin (`cli-watchdog.ts`; `watchdog.ts` itself sends no signal and takes this as
 * its optional `reap` dependency). Two cases, both for this user's own processes only:
 *
 * - A device CoreSimulator reports `Shutdown` (or no longer lists) that still has runtime processes, found by `SIMULATOR_UDID` in their
 *   environment: they are sent SIGTERM, and SIGKILL once they have outlived a cycle. A killed test run leaves these behind with their
 *   `launchd_sim` gone, so nothing else would ever stop them.
 * - A device that is `Booted` and idle past the watchdog's threshold: `simctl shutdown`, bounded. Its processes exit with it, and any that do not
 *   are the first case from the next cycle.
 *
 * Nothing is touched while any `xcodebuild` test action runs on the machine or a tool of the build chain names the device, and nothing at
 * all when the device list cannot be read. Every action is one `simulator-reap` line in `events.jsonl`.
 */
import { execFileSync } from "node:child_process";
import { isSimulatorCommand, runsTool, XCODE_TOOLS } from "./ps.js";
/** The bound on every `simctl` and `ps` call here: `simctl` can hang. */
export const SIMCTL_TIMEOUT_MS = 30_000;
const UDID = "[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
const ENV_UDID = new RegExp(`^\\s*(\\d+)\\s.*?\\bSIMULATOR_UDID=(${UDID})\\b`);
const isTestAction = (command) => runsTool(command, ["xcodebuild"]) && /\s(?:test|test-without-building)(?=\s|$)/.test(command);
/** Device UDID → state from `simctl list devices -j`. Throws on text that is not that shape. */
function deviceStates(text) {
    const { devices } = JSON.parse(text);
    return new Map(Object.values(devices).flatMap((list) => list.map((d) => [d.udid.toUpperCase(), d.state])));
}
/** Leftover runtime pids by device UDID: this user's simulator rows whose environment names a device. */
function runtimePidsByDevice(procs, deps) {
    const pids = procs.filter((p) => p.uid === deps.uid && isSimulatorCommand(p.command)).map((p) => p.pid);
    const byDevice = new Map();
    if (pids.length === 0)
        return byDevice;
    for (const line of deps.processEnv(pids).split("\n")) {
        const m = ENV_UDID.exec(line);
        if (m)
            byDevice.set(m[2].toUpperCase(), [...(byDevice.get(m[2].toUpperCase()) ?? []), Number(m[1])]);
    }
    return byDevice;
}
/** Runs one cycle and returns the attempts to carry to the next: only devices that still have leftovers. Never throws. */
export function reapSimulators({ procs, idleUdids, attempts }, deps) {
    if (procs.some((p) => isTestAction(p.command)))
        return attempts;
    let states;
    let leftovers;
    try {
        states = deviceStates(deps.listDevices());
        leftovers = runtimePidsByDevice(procs, deps);
    }
    catch {
        return attempts;
    }
    const inUse = (udid) => procs.some((p) => runsTool(p.command, XCODE_TOOLS) && p.command.toUpperCase().includes(udid));
    const next = {};
    for (const [udid, pids] of leftovers) {
        const state = states.get(udid);
        if (state !== undefined && state !== "Shutdown")
            continue;
        if (inUse(udid)) {
            if (attempts[udid] !== undefined)
                next[udid] = attempts[udid];
            continue;
        }
        const attempt = (attempts[udid] ?? 0) + 1;
        next[udid] = attempt;
        const [signal, action] = attempt >= 2 ? ["SIGKILL", "kill"] : ["SIGTERM", "terminate"];
        const done = [];
        const failed = [];
        for (const pid of pids) {
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
        if (states.get(udid) !== "Booted" || inUse(udid))
            continue;
        try {
            deps.shutdown(udid);
            deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: true });
        }
        catch (err) {
            deps.log({ type: "simulator-reap", udid, reason: "booted-idle", action: "shutdown", ok: false, message: err.message });
        }
    }
    return next;
}
const execBounded = (file, args, timeoutMs) => execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
/** The real seams: `xcrun simctl`, `ps -E` and `process.kill`, each external call bounded by `SIMCTL_TIMEOUT_MS`; `exec` and `uid` are test seams. */
export function realReaperDeps({ log, exec = execBounded, uid = process.getuid() }) {
    return {
        listDevices: () => exec("xcrun", ["simctl", "list", "devices", "-j"], SIMCTL_TIMEOUT_MS),
        processEnv: (pids) => (pids.length === 0 ? "" : exec("ps", ["-Eww", "-p", pids.join(","), "-o", "pid=,command="], SIMCTL_TIMEOUT_MS)),
        shutdown: (udid) => void exec("xcrun", ["simctl", "shutdown", udid], SIMCTL_TIMEOUT_MS),
        signal: (pid, signal) => void process.kill(pid, signal),
        log,
        uid,
    };
}
//# sourceMappingURL=simulator-reaper.js.map