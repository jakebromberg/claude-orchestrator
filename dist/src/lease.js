/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under `heavyCapacity(level, policy)`. Liveness is a live
 * wrapper PID or a live child PID, so a crashed or killed holder cannot leak a
 * slot. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLockOnce } from "./file-lock.js";
import { defaultPressureSampler, heavyCapacity, leaseDirectory, pressurePolicyFromEnv, } from "./memory-pressure.js";
const MUTEX_STALE_MS = 10_000;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
const FAIL_OPEN_MS = 30_000;
const POLL_MS = 3_000;
const COMMAND_MAX = 200;
const OVERRIDE_VALUE = "critical-as-warning";
const holdersDir = (dir) => join(dir, "holders");
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/** The single liveness rule (CO-5 extends it for detached holders). */
function verdict(rec, nowMs, alive) {
    if (!rec || typeof rec.startedAt !== "number")
        return "corrupt";
    if (alive(rec.pid))
        return "live";
    if (rec.childPid && alive(rec.childPid))
        return nowMs - rec.startedAt > ORPHAN_MAX_MS ? "orphan-bound" : "live";
    return "dead";
}
function scanHolders(opts) {
    const { isAlive = pidAlive, now = Date.now } = opts;
    const dir = holdersDir(opts.dir);
    const found = { live: [], dead: [] };
    let names;
    try {
        names = readdirSync(dir);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return found;
        throw err;
    }
    const nowMs = now();
    for (const name of names.filter((n) => n.endsWith(".json"))) {
        const file = join(dir, name);
        try {
            let rec = null;
            try {
                rec = JSON.parse(readFileSync(file, "utf8"));
            }
            catch {
                // Unparseable counts as corrupt below.
            }
            const v = verdict(rec, nowMs, isAlive);
            if (v === "live")
                found.live.push({ ...rec, ageSec: Math.round((nowMs - rec.startedAt) / 1000) });
            else
                found.dead.push({ id: name.slice(0, -".json".length), reason: v });
        }
        catch {
            // The holder released between readdir and stat.
        }
    }
    return found;
}
const ASSIGNMENT = '[A-Za-z_]\\w*=(?:"[^"]*"|\'[^\']*\'|[^\\s;&|()]*)';
const SEGMENT_ASSIGNMENTS = new RegExp(`((?:^|&&|\\|\\||[;|(])\\s*)((?:${ASSIGNMENT}\\s+)*${ASSIGNMENT})`, "g");
/** Redacts the value of every `NAME=value` at the start of a segment, then truncates. */
function recordedCommand({ command, label }) {
    const text = label ?? command.replace(SEGMENT_ASSIGNMENTS, (_, lead, run) => lead + run.replace(new RegExp(ASSIGNMENT, "g"), (a) => `${a.slice(0, a.indexOf("="))}=…`));
    return text.slice(0, COMMAND_MAX);
}
function createHolder(opts, meta, level, capacity, live, waitedMs) {
    const now = opts.now ?? Date.now;
    const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const file = join(holdersDir(opts.dir), `${id}.json`);
    const rec = { id, pid: process.pid, command: recordedCommand(meta), cwd: meta.cwd, startedAt: now(), level };
    if (opts.override && level === "warning")
        rec.override = true;
    const write = () => {
        writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
    };
    write();
    let released = false;
    opts.onEvent?.({ type: "acquire", id, waitedMs, level, live, capacity });
    return {
        id,
        leased: true,
        admission: { waitedMs, level, live, capacity },
        childEnv: () => ({ CO_LEASE_HOLDER: id }),
        setChildPid(pid) {
            rec.childPid = pid;
            try {
                write();
            }
            catch {
                // The previous record still names this holder.
            }
        },
        release(outcome) {
            if (released)
                return;
            released = true;
            try {
                unlinkSync(file);
            }
            catch {
                // Already reaped.
            }
            opts.onEvent?.({ type: "release", id, exitCode: outcome?.exitCode });
        },
    };
}
function borrowedHandle(id, level, capacity, live) {
    return { id, leased: true, admission: { waitedMs: 0, level, live, capacity }, childEnv: () => ({ CO_LEASE_HOLDER: id }), setChildPid() { }, release() { } };
}
/** One admission attempt: sample the level, then count and write holders under the mutex. */
function attempt(opts, meta, waitedMs) {
    const level = opts.level();
    const capacity = heavyCapacity(level, opts.policy);
    try {
        const scan = scanHolders(opts);
        if (opts.inheritedHolderId && scan.live.some((h) => h.id === opts.inheritedHolderId)) {
            return { kind: "admitted", handle: borrowedHandle(opts.inheritedHolderId, level, capacity, scan.live.length) };
        }
        mkdirSync(holdersDir(opts.dir), { recursive: true, mode: 0o700 });
        const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
        if (!lock)
            return { kind: "busy", level, capacity };
        try {
            const { live, dead } = scanHolders(opts);
            for (const { id, reason } of dead) {
                try {
                    unlinkSync(join(holdersDir(opts.dir), `${id}.json`));
                }
                catch {
                    // Another process reaped it first.
                }
                if (reason === "orphan-bound")
                    (opts.warn ?? defaultWarn)(`lease: reaping holder ${id}: its child outlived the 2 h orphan bound`);
                opts.onEvent?.({ type: "reap", id, reason });
            }
            if (live.length >= capacity)
                return { kind: "full", level, capacity };
            return { kind: "admitted", handle: createHolder(opts, meta, level, capacity, live.length + 1, waitedMs) };
        }
        finally {
            lock.release();
        }
    }
    catch {
        return { kind: "error", level, capacity };
    }
}
const defaultWarn = (msg) => {
    process.stderr.write(`[lease] ${msg}\n`);
};
function failOpen(opts, level, capacity, waitedMs, reason) {
    (opts.warn ?? defaultWarn)(`lease unavailable (${reason}); running unleased`);
    opts.onEvent?.({ type: "fail-open", reason, waitedMs });
    return { id: null, leased: false, admission: { waitedMs, level, live: 0, capacity }, childEnv: () => ({}), setChildPid() { }, release() { } };
}
/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. */
export function tryAcquireLease(opts, meta) {
    const r = attempt(opts, meta, 0);
    if (r.kind === "admitted")
        return r.handle;
    return r.kind === "error" && r.level !== "critical" ? failOpen(opts, r.level, r.capacity, 0, "io-error") : null;
}
/** Live holders, or none when the directory cannot be read. */
function statusOf(opts, level) {
    const capacity = heavyCapacity(level, opts.policy);
    try {
        return { level, capacity, live: scanHolders(opts).live };
    }
    catch {
        return { level, capacity, live: [] };
    }
}
/**
 * Polls (3 s ± 1 s, never spinning) until admitted. `stopWhen` is checked on
 * every poll, and a stop is confirmed with a `level.fresh()` re-read before it
 * is returned, so one stale cached sample cannot end a wave.
 */
export async function acquireLease(opts, meta, wait = {}) {
    const { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS } = opts;
    const start = now();
    let busySince;
    for (;;) {
        const waitedMs = now() - start;
        const r = attempt(opts, meta, waitedMs);
        if (r.kind === "admitted")
            return r.handle;
        busySince = r.kind === "busy" ? (busySince ?? now()) : undefined;
        if (r.level !== "critical") {
            if (r.kind === "error")
                return failOpen(opts, r.level, r.capacity, waitedMs, "io-error");
            if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS)
                return failOpen(opts, r.level, r.capacity, waitedMs, "mutex-busy");
        }
        const status = r.kind === "error" ? { level: r.level, capacity: r.capacity, live: [] } : statusOf(opts, r.level);
        const refuse = (refused, level, live) => {
            opts.onEvent?.({ type: "timeout", refused, waitedMs });
            return { refused, waitedMs, level, live };
        };
        if (wait.stopWhen?.(status)) {
            const level = opts.level.fresh();
            if (wait.stopWhen({ ...status, level, capacity: heavyCapacity(level, opts.policy) }))
                return refuse("stopped", level, status.live.length);
        }
        if (wait.maxWaitMs !== undefined && waitedMs >= wait.maxWaitMs)
            return refuse("max-wait", r.level, status.live.length);
        wait.onWait?.(status);
        const jittered = Math.round(pollMs * (2 / 3 + Math.random() * (2 / 3)));
        await sleep(wait.maxWaitMs === undefined ? jittered : Math.min(jittered, wait.maxWaitMs - waitedMs));
    }
}
/** Read-only: creates nothing, reaps nothing. */
export function leaseStatus(opts) {
    const level = opts.level();
    return { level, capacity: heavyCapacity(level, opts.policy), live: scanHolders(opts).live };
}
/** Production wiring: the real lease directory and the engine's own sampler and policy. Creates nothing on disk. */
export function defaultLeaseOptions(env = process.env) {
    return {
        dir: leaseDirectory(env),
        level: defaultPressureSampler(env),
        policy: pressurePolicyFromEnv(env),
        inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
        override: env.CO_PRESSURE_OVERRIDE === OVERRIDE_VALUE,
    };
}
//# sourceMappingURL=lease.js.map