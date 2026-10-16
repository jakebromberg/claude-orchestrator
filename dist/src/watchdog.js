/**
 * The watchdog's scan-and-classify core: one bounded `ps` scan, a list of rules over it, and reporters that write
 * `watchdog.json`, `watchdog.brief` and `watchdog.log` in the lease directory. It runs outside every engine tree, so a
 * stopped tree cannot silence it. It sends no signal: its dependencies are `ps`, the clock and the file system, and an
 * engine's liveness is whether its pid has a row in the scan.
 */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REFRESH_MS } from "./engine-registry.js";
import { isWithinWindow } from "./file-lock.js";
import { isOwnDir, writeLeaseRecord } from "./lease-dir.js";
import { isPid } from "./lease.js";
import { ps } from "./ps.js";
const EX_USAGE = 64;
const USAGE = "usage: claude-orchestrator-watchdog check | brief";
/** A stopped group with no suspension record is reported this long after it was first seen stopped. */
export const STOPPED_AFTER_MS = 5 * 60_000;
/** An engine record is fresh for three refresh periods, the lease's heartbeat rule. */
export const ENGINE_FRESH_MS = 3 * REFRESH_MS;
// A planted symlink is not followed and a planted FIFO is not waited on.
const LOG_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const minutes = (ms) => Math.floor(ms / 60_000);
const unrecordedStoppedGroup = (c) => [...c.stoppedSince]
    .filter(([pgid, since]) => !c.suspended.has(pgid) && c.now - since >= STOPPED_AFTER_MS)
    .map(([pgid, since]) => ({ key: `stopped:${pgid}`, message: `process group ${pgid} stopped ${minutes(c.now - since)}m, no suspension record` }));
// A stale record whose pid is alive is a stopped or wedged engine; the stopped-group rule reports it by group.
const deadEngine = (c) => c.engines
    .filter((e) => !e.fresh && !e.alive)
    .map((e) => ({ key: `dead:${e.runId}`, message: `engine ${e.runId} (pid ${e.pid}) died, its record is left in engines/`, once: true }));
/** The rules, in report order. A rule reads the context and returns findings; the reporters never change. */
export const RULES = [unrecordedStoppedGroup, deadEngine];
/** The default scan: one bounded `ps`, 60 s because it can be slow at background priority. A throw skips the cycle. */
export const scanProcessTable = () => ps(["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,command="], { timeoutMs: 60_000 });
function parseTable(text) {
    return text.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+(\S+)\s+\S+\s+(.*)$/.exec(line);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], command: m[5] }] : [];
    });
}
/** The `*.json` files of `<dir>/<sub>` (a temp file of `writeFileAtomic` ends in `.tmp`), parsed; one that is gone or unparsable is skipped. */
function readRecords(dir, sub) {
    let names;
    try {
        names = readdirSync(join(dir, sub)).filter((n) => n.endsWith(".json"));
    }
    catch {
        return [];
    }
    return names.flatMap((name) => {
        try {
            const file = join(dir, sub, name);
            return [{ name, record: JSON.parse(readFileSync(file, "utf-8")), mtimeMs: statSync(file).mtimeMs }];
        }
        catch {
            return [];
        }
    });
}
function readEngines(dir, now, procs) {
    return readRecords(dir, "engines").flatMap(({ record: r, mtimeMs }) => {
        if (!isPid(r?.pid) || typeof r.runId !== "string")
            return [];
        const row = procs.find((p) => p.pid === r.pid);
        // A null pgid (ps failed at engine start) falls back to the scan's.
        return [{ ...r, pgid: Number.isInteger(r.pgid) ? r.pgid : (row?.pgid ?? null), fresh: isWithinWindow(mtimeMs, now, ENGINE_FRESH_MS), alive: row !== undefined }];
    });
}
/** Groups whose every member is stopped (`stat` starts with `T`) and that contain or descend from a `claude` process, or belong to a live registered engine. */
function stoppedGroups(procs, engines) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const isClaude = (p) => /(^|[\s/])claude(\s|$)/.test(p.command);
    const underClaude = (p) => {
        for (let cur = p, n = 0; cur && n < 64; cur = byPid.get(cur.ppid), n++)
            if (isClaude(cur))
                return true;
        return false;
    };
    const enginePgids = new Set(engines.filter((e) => e.alive).map((e) => e.pgid));
    const groups = new Map();
    for (const p of procs)
        groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
    return [...groups].filter(([pgid, members]) => members.every((p) => p.stat.startsWith("T")) && (enginePgids.has(pgid) || members.some(underClaude))).map(([pgid]) => pgid);
}
function readState(dir) {
    try {
        const s = JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf-8"));
        return { stoppedSince: s.stoppedSince ?? {}, reported: s.reported ?? [], findings: s.findings ?? [] };
    }
    catch {
        return { stoppedSince: {}, reported: [], findings: [] };
    }
}
/** Appends one line to `watchdog.log`; only a regular file is appended to, and a new one has mode 0600. A failure is swallowed: the log is a diagnostic. */
function appendLog(dir, now, text) {
    try {
        const fd = openSync(join(dir, "watchdog.log"), LOG_FLAGS, 0o600);
        try {
            if (fstatSync(fd).isFile())
                appendFileSync(fd, `${new Date(now).toISOString()} ${text}\n`);
        }
        finally {
            closeSync(fd);
        }
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
        procs = parseTable(d.scan());
        if (procs.length === 0)
            throw new Error("empty process table");
    }
    catch (err) {
        appendLog(d.dir, now, `scan skipped: ${err.message}`);
        return;
    }
    const engines = readEngines(d.dir, now, procs);
    const stoppedSince = new Map(stoppedGroups(procs, engines).map((pgid) => [pgid, prev.stoppedSince[pgid] ?? now]));
    const suspended = new Set(readRecords(d.dir, "suspensions").map(({ name }) => Number(name.slice(0, -".json".length))));
    const found = RULES.flatMap((rule) => rule({ now, procs, engines, suspended, stoppedSince }));
    const findings = found.filter((f) => !(f.once && prev.reported.includes(f.key)));
    const state = { stoppedSince: Object.fromEntries(stoppedSince), reported: found.filter((f) => f.once).map((f) => f.key), findings };
    writeLeaseRecord(d.dir, "watchdog.json", JSON.stringify({ checkedAt: new Date(now).toISOString(), ...state }));
    writeLeaseRecord(d.dir, "watchdog.brief", findings.length ? `watchdog: ${findings.map((f) => f.message).join("; ")}` : "");
    for (const f of findings)
        if (!prev.findings.some((p) => p.key === f.key))
            appendLog(d.dir, now, f.message);
}
/** Runs `check` or `brief` (`argv[0]`): exit 0 done, 64 usage. `brief` prints `watchdog.brief`, and nothing when it is empty or missing. */
export function runWatchdog(argv, d) {
    if (argv.length !== 1 || (argv[0] !== "check" && argv[0] !== "brief")) {
        d.err(USAGE);
        return EX_USAGE;
    }
    if (argv[0] === "check")
        check(d);
    else {
        let line = "";
        try {
            line = readFileSync(join(d.dir, "watchdog.brief"), "utf-8");
        }
        catch { }
        if (line)
            d.out(line);
    }
    return 0;
}
//# sourceMappingURL=watchdog.js.map