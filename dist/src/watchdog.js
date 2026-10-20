/**
 * The watchdog's scan-and-classify core: one bounded `ps` scan, a list of rules over it, and reporters that write
 * `watchdog.json`, `watchdog.brief` and `watchdog.log` in the lease directory. It runs outside every engine tree, so a
 * stopped tree cannot silence it. It sends no signal: its dependencies are `ps`, the clock and the file system, and an
 * engine's liveness is whether its pid has a row in the scan for a process that started no later than the record.
 */
import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeBoundedFailure } from "./bounded-failure.js";
import { REFRESH_MS } from "./engine-registry.js";
import { isWithinWindow } from "./file-lock.js";
import { appendOwnLine, isOwnDir, readLeaseRecord, readRecordDir, writeLeaseRecord } from "./lease-dir.js";
import { ancestry, isClaudeCommand, isPid, isSimulatorCommand, parsePsTable, ps, PS_TABLE_ARGS, runsTool, simulatorUdid, XCODE_TOOLS } from "./ps.js";
import { isLeaseRecord, readSuspensions } from "./suspensions.js";
const EX_USAGE = 64;
const USAGE = "usage: claude-orchestrator-watchdog check | brief | print-plist | print-status-line";
/** A stopped group with no suspension record is reported this long after it was first seen stopped. */
export const STOPPED_AFTER_MS = 5 * 60_000;
/** An engine record is fresh for three refresh periods, the lease's heartbeat rule. */
export const ENGINE_FRESH_MS = 3 * REFRESH_MS;
/** A stale engine record whose pid is alive and running is reported once it is older than the engine's `stallTimeout` plus this. */
export const STALLED_MARGIN_MS = 10 * 60_000;
/** A lease suspension (`by: "lease"`) older than this is reported. */
export const LEASE_SUSPENSION_MAX_MS = 30 * 60_000;
/** A booted simulator with no `xcodebuild` or `simctl` running is reported this long after it was first seen idle. */
export const SIMULATOR_IDLE_AFTER_MS = 5 * 60_000;
const minutes = (ms) => Math.floor(ms / 60_000);
/** Slack on the pid-reuse check: `etime` has one-second resolution and the registry stamps `startedAt` just after the engine starts. */
const START_SLACK_MS = 5_000;
const unrecordedStoppedGroup = (c) => [...c.stoppedSince]
    .filter(([pgid, since]) => !c.suspended.has(pgid) && c.now - since >= STOPPED_AFTER_MS)
    .map(([pgid, since]) => ({ key: `stopped:${pgid}`, message: `process group ${pgid} stopped ${minutes(c.now - since)}m, no suspension record` }));
// A stale record whose pid is alive is a stopped or wedged engine. Its sessions share its group, so the group is
// rarely stopped throughout, and the engine is reported on its own: on the stopped-group bound when its own stat is T,
// and otherwise (running, but not refreshing) only past its stallTimeout + 10 minutes, since a healthy engine stops
// refreshing while a long synchronous command blocks its event loop. At stallTimeout 0 (no silence check) a running
// engine is never reported. The report yields once the stopped-group rule reports the group, and a group with a
// suspension record is skipped.
const stalledAfterMs = (e) => (e.stopped ? STOPPED_AFTER_MS : e.stallTimeout > 0 ? e.stallTimeout * 1000 + STALLED_MARGIN_MS : Infinity);
const stalledEngine = (c) => c.engines
    .filter((e) => !e.fresh && e.alive && c.now - e.mtimeMs >= stalledAfterMs(e))
    .filter((e) => e.pgid === null || !(c.suspended.has(e.pgid) || c.now - (c.stoppedSince.get(e.pgid) ?? c.now) >= STOPPED_AFTER_MS))
    .map((e) => ({ key: `stalled:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) has not refreshed its record for ${minutes(c.now - e.mtimeMs)}m and is still alive: stopped or wedged` }));
const deadEngine = (c) => c.engines
    .filter((e) => !e.fresh && !e.alive)
    .map((e) => ({ key: `dead:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) died, its record is left in engines/`, once: true }));
// A due reminder is reported while the recorded group is stopped throughout, whatever tree it is in (`c.stoppedSince`
// holds only in-scope groups). A recorded group with no live members is a stale record, reported once and kept.
const dueReminder = (c) => c.records
    .filter((r) => Date.parse(r.remindAt) <= c.now)
    .flatMap((r) => {
    const members = c.procs.filter((p) => p.pgid === r.pgid);
    if (members.length === 0)
        return [{ key: `stale-record:${r.pgid}`, message: `suspension record for process group ${r.pgid} has no live members, left in suspensions/`, once: true }];
    return members.every((p) => p.stat.startsWith("T")) ? [{ key: `reminder:${r.pgid}`, message: `process group ${r.pgid} is still suspended by ${r.by} (${r.reason}), reminder due` }] : [];
});
const oldLeaseSuspension = (c) => c.records
    .filter((r) => isLeaseRecord(r) && c.now - Date.parse(r.at) >= LEASE_SUSPENSION_MAX_MS)
    .map((r) => ({ key: `lease-suspended:${r.pgid}`, message: `process group ${r.pgid} suspended by the lease ${minutes(c.now - Date.parse(r.at))}m (${r.reason})` }));
// A fresh record is refreshing, so a silent engine is a live one that writes no session log: exclusive with stalledEngine by freshness.
const silentEngine = (c) => c.engines
    .filter((e) => e.fresh && e.stallTimeout > 0 && c.now - e.activityMs > e.stallTimeout * 1000 + STALLED_MARGIN_MS)
    .map((e) => ({ key: `silent:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) wrote no session log for ${minutes(c.now - e.activityMs)}m` }));
// Report only: the owner runs the suggested `simctl shutdown`, the watchdog never does.
const idleSimulator = (c) => [...c.idleSimulators]
    .filter(([, d]) => c.now - d.since >= SIMULATOR_IDLE_AFTER_MS)
    .map(([udid, d]) => ({
    key: `sim-idle:${udid}`,
    message: `simulator ${udid} booted and idle ${minutes(c.now - d.since)}m${d.rssBytes === undefined ? "" : `, holding ${(d.rssBytes / 2 ** 30).toFixed(1)} GB`}; to reclaim it run: xcrun simctl shutdown ${udid}`,
    once: true,
}));
/** The rules, in report order. A rule reads the context and returns findings; the reporters never change. */
export const RULES = [unrecordedStoppedGroup, dueReminder, oldLeaseSuspension, stalledEngine, silentEngine, deadEngine, idleSimulator];
/** The scan's bound, 60 s because `ps` can be slow at background priority. */
export const SCAN_TIMEOUT_MS = 60_000;
/** The default scan: one bounded `ps`. A throw skips the cycle. */
export const scanProcessTable = () => ps(PS_TABLE_ARGS, { timeoutMs: SCAN_TIMEOUT_MS });
/** Whether `row` can be the process that wrote a record started at `startedAt`: one that started later holds a reused pid. An unreadable time on either side keeps the row. */
function isSameProcess(row, startedAt, now) {
    const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
    return !(now - row.elapsedMs > started + START_SLACK_MS);
}
/** The newest mtime among the regular `*.log` files directly in `logDir`, else the record's `startedAt` (NaN when unreadable). */
function activityOf(logDir, startedAt) {
    let newest = -Infinity;
    try {
        for (const n of readdirSync(String(logDir)).filter((n) => n.endsWith(".log"))) {
            const st = statSync(join(String(logDir), n), { throwIfNoEntry: false });
            if (st?.isFile())
                newest = Math.max(newest, st.mtimeMs);
        }
    }
    catch { }
    return newest > -Infinity ? newest : typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
}
function readEngines(dir, now, procs) {
    return readRecordDir(dir, "engines").flatMap(({ text, mtimeMs }) => {
        let r;
        try {
            r = JSON.parse(text);
        }
        catch {
            return [];
        }
        if (!isPid(r?.pid) || typeof r.runId !== "string")
            return [];
        const row = procs.find((p) => p.pid === r.pid);
        // A null pgid (ps failed at engine start) falls back to the scan's.
        const fresh = isWithinWindow(mtimeMs, now, ENGINE_FRESH_MS);
        const stallTimeout = Number.isFinite(r.stallTimeout) && r.stallTimeout >= 0 ? r.stallTimeout : 0;
        return [{ ...r, pgid: Number.isInteger(r.pgid) ? r.pgid : (row?.pgid ?? null), fresh, alive: row !== undefined && isSameProcess(row, r.startedAt, now), mtimeMs, stopped: row?.stat.startsWith("T") ?? false, stallTimeout, activityMs: fresh && stallTimeout > 0 ? activityOf(r.logDir, r.startedAt) : NaN }];
    });
}
/** Groups whose every member is stopped (`stat` starts with `T`) and that contain or descend from a `claude` process, or belong to a live registered engine. */
function stoppedGroups(procs, engines) {
    const isClaude = (p) => isClaudeCommand(p.command);
    const underClaude = (p) => ancestry(procs, p.pid, 64).chain.some(isClaude);
    const enginePgids = new Set(engines.filter((e) => e.alive).map((e) => e.pgid));
    const groups = new Map();
    for (const p of procs)
        groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
    return [...groups].filter(([pgid, members]) => members.every((p) => p.stat.startsWith("T")) && (enginePgids.has(pgid) || members.some(underClaude))).map(([pgid]) => pgid);
}
/** Booted simulators by UDID (the `launchd_sim` row naming `Devices/<udid>/`) with the readable rss of every simulator process under it, one pid map for the scan. Idle ones only: none when an `xcodebuild` or `simctl` is running. */
function idleSimulatorRss(procs) {
    const toolRunning = procs.some((p) => runsTool(p.command, XCODE_TOOLS));
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const roots = new Map(procs.flatMap((p) => (p.command.includes("launchd_sim") && simulatorUdid(p.command) ? [[p.pid, simulatorUdid(p.command)]] : [])));
    const totals = new Map();
    if (toolRunning)
        return totals;
    for (const udid of roots.values())
        totals.set(udid, undefined);
    for (const p of procs.filter((p) => isSimulatorCommand(p.command))) {
        let up = p;
        for (let i = 0; up && i < 64 && !roots.has(up.pid); i++)
            up = byPid.get(up.ppid);
        const udid = up && roots.get(up.pid);
        if (udid && Number.isFinite(p.rssBytes))
            totals.set(udid, (totals.get(udid) ?? 0) + p.rssBytes);
    }
    return totals;
}
function readState(dir) {
    try {
        const s = JSON.parse(readLeaseRecord(dir, "watchdog.json")?.text ?? "{}");
        return { stoppedSince: s.stoppedSince ?? {}, idleSimulators: s.idleSimulators ?? {}, reported: s.reported ?? [], findings: s.findings ?? [] };
    }
    catch {
        return { stoppedSince: {}, idleSimulators: {}, reported: [], findings: [] };
    }
}
/** Appends one line to `watchdog.log` through `appendOwnLine`: only a regular file this user owns is appended to (a symlink is not followed, a FIFO not waited on), and a new one has mode 0600. A failure is swallowed: the log is a diagnostic. */
function appendLog(dir, now, text) {
    try {
        appendOwnLine(join(dir, "watchdog.log"), `${new Date(now).toISOString()} ${text}`);
    }
    catch { }
}
/**
 * One cycle: scan, run every rule, then write `watchdog.json`, `watchdog.brief` (the one-line summary, empty when all
 * is well) and `watchdog.log` (each newly emitted finding). Writes nothing unless the lease directory passes the
 * lease's directory rule, and never creates it. A scan that throws or returns no rows skips the cycle: the previous
 * state stays and the skip is logged. A dead engine's record is reported once per `runId` and never deleted.
 */
export function check(d) {
    const st = lstatSync(d.dir, { throwIfNoEntry: false });
    if (!st || !isOwnDir(st))
        return;
    const now = d.now();
    const prev = readState(d.dir);
    let procs;
    try {
        procs = parsePsTable(d.scan());
        if (procs.length === 0)
            throw new Error("empty process table");
    }
    catch (err) {
        appendLog(d.dir, now, `scan skipped: ${describeBoundedFailure(err, SCAN_TIMEOUT_MS)}`);
        return;
    }
    const engines = readEngines(d.dir, now, procs);
    const stoppedSince = new Map(stoppedGroups(procs, engines).map((pgid) => [pgid, prev.stoppedSince[pgid] ?? now]));
    const idleSimulators = new Map([...idleSimulatorRss(procs)].map(([udid, rssBytes]) => [udid, { since: prev.idleSimulators[udid] ?? now, rssBytes }]));
    const records = readSuspensions(d.dir);
    const suspended = new Set(records.map((r) => r.pgid));
    const found = RULES.flatMap((rule) => rule({ now, procs, engines, suspended, records, stoppedSince, idleSimulators }));
    const findings = found.filter((f) => !(f.once && prev.reported.includes(f.key)));
    const state = { stoppedSince: Object.fromEntries(stoppedSince), idleSimulators: Object.fromEntries([...idleSimulators].map(([udid, d]) => [udid, d.since])), reported: found.filter((f) => f.once).map((f) => f.key), findings };
    writeLeaseRecord(d.dir, "watchdog.json", JSON.stringify({ checkedAt: new Date(now).toISOString(), ...state }));
    writeLeaseRecord(d.dir, "watchdog.brief", findings.length ? `watchdog: ${findings.map((f) => f.message).join("; ")}` : "");
    for (const f of findings)
        if (!prev.findings.some((p) => p.key === f.key))
            appendLog(d.dir, now, f.message);
}
/** Free fraction of the lease directory's volume below which `brief` reports a full disk. */
export const DISK_FULL_FRACTION = 0.02;
/** The disk-full line's text; `print-status-line` reuses it so the shell and `brief` say the same thing. */
export function diskFullText(dir, pct) {
    return `watchdog: the disk holding ${dir} is nearly full (${pct}% free); heavy commands are refused once the lease cannot write`;
}
/** A disk-full line when the lease directory's volume is nearly out of space, read live (a full disk fails every record write), else `""`. */
function diskFullLine(dir, statfs) {
    try {
        const { bavail, blocks } = statfs(dir);
        return blocks > 0 && bavail / blocks < DISK_FULL_FRACTION ? diskFullText(dir, ((bavail / blocks) * 100).toFixed(1)) : "";
    }
    catch {
        return "";
    }
}
/** Runs `check` or `brief` (`argv[0]`): exit 0 done, 64 usage. `brief` prints `watchdog.brief` (nothing when it is empty or missing), then a disk-full line when the volume is nearly full (a live `statfsSync`, no file written). */
export function runWatchdog(argv, d) {
    if (argv.length !== 1 || (argv[0] !== "check" && argv[0] !== "brief")) {
        d.err(USAGE);
        return EX_USAGE;
    }
    if (argv[0] === "check")
        check(d);
    else {
        const line = readLeaseRecord(d.dir, "watchdog.brief")?.text;
        if (line)
            d.out(line);
        const full = diskFullLine(d.dir, d.statfs ?? statfsSync);
        if (full)
            d.out(full);
    }
    return 0;
}
//# sourceMappingURL=watchdog.js.map