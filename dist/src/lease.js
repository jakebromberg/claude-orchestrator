/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under `heavyCapacity(level, policy)`. Liveness is a live
 * wrapper PID or a live child PID, so a crashed or killed holder cannot leak a
 * slot. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLockOnce } from "./file-lock.js";
import { defaultPressureSampler, heavyCapacity, leaseDirectory, pressureOverrideInEffect, pressurePolicyFromEnv, } from "./memory-pressure.js";
const MUTEX_STALE_MS = 10_000;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
const FAIL_OPEN_MS = 30_000;
const POLL_MS = 3_000;
const COMMAND_MAX = 200;
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
/**
 * The single liveness rule; the heartbeat (#112) and CO-5's detached holders
 * (#105) extend it. Until the heartbeat lands, a recycled wrapper PID can pin a
 * slot. `null` is a file that is not a holder record.
 */
function verdict(rec, nowMs, alive) {
    if (!rec)
        return "corrupt";
    if (alive(rec.pid))
        return "live";
    if (rec.childPid && alive(rec.childPid))
        return nowMs - rec.startedAt > ORPHAN_MAX_MS ? "orphan-bound" : "live";
    return "dead";
}
/** `read()`, or `undefined` when the path is gone. Any other error is an I/O error and throws. */
function unlessGone(read) {
    try {
        return read();
    }
    catch (err) {
        if (err.code === "ENOENT")
            return undefined;
        throw err;
    }
}
function parseHolder(text) {
    try {
        const rec = JSON.parse(text);
        return typeof rec?.pid === "number" && typeof rec.startedAt === "number" ? rec : null;
    }
    catch {
        return null;
    }
}
/** Throws on an I/O error; a file released since the `readdir` is skipped, and only an unparseable or malformed one is corrupt. */
function scanHolders(opts) {
    const { isAlive = pidAlive, now = Date.now } = opts;
    const dir = holdersDir(opts.dir);
    const found = { live: [], dead: [] };
    const names = unlessGone(() => readdirSync(dir)) ?? [];
    const nowMs = now();
    for (const name of names.filter((n) => n.endsWith(".json"))) {
        const text = unlessGone(() => readFileSync(join(dir, name), "utf8"));
        if (text === undefined)
            continue;
        const rec = parseHolder(text);
        const v = verdict(rec, nowMs, isAlive);
        if (v === "live")
            found.live.push({ ...rec, ageSec: Math.round((nowMs - rec.startedAt) / 1000) });
        else
            found.dead.push({ id: name.slice(0, -".json".length), reason: v });
    }
    return found;
}
const ASSIGNMENT = '[A-Za-z_]\\w*=(?:"[^"]*"|\'[^\']*\'|[^\\s;&|()]*)';
// A segment starts at the beginning, a newline, or after `;`, `|`, `&` (so also `||` and `&&`), `(` or `{`.
const SEGMENT_ASSIGNMENTS = new RegExp(`((?:^|[;|&(\\n{])\\s*)((?:${ASSIGNMENT}\\s+)*${ASSIGNMENT})`, "g");
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
    emit(opts, { type: "acquire", id, waitedMs, level, live, capacity });
    return {
        id,
        leased: true,
        admission: { waitedMs, level, live, capacity },
        childEnv: () => ({ CO_LEASE_HOLDER: id }),
        setChildPid(pid) {
            if (released)
                return;
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
            emit(opts, { type: "release", id, exitCode: outcome?.exitCode });
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
                rmSync(join(holdersDir(opts.dir), `${id}.json`), { force: true });
                if (reason === "orphan-bound")
                    warn(opts, `lease: reaping holder ${id}: its child outlived the 2 h orphan bound`);
                emit(opts, { type: "reap", id, reason });
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
const failedCallbacks = new WeakSet();
/** Runs a caller's `onEvent` or `warn`. A throw is warned about once per callback and never changes what the lease does. */
function guarded(opts, callback, arg) {
    try {
        callback?.call(opts, arg);
    }
    catch (err) {
        if (!callback || failedCallbacks.has(callback))
            return;
        failedCallbacks.add(callback);
        warn(opts, `lease: a callback threw and is ignored: ${String(err)}`);
    }
}
const warn = (opts, msg) => guarded(opts, opts.warn ?? defaultWarn, msg);
const emit = (opts, e) => guarded(opts, opts.onEvent, e);
function failOpen(opts, level, capacity, waitedMs, reason) {
    warn(opts, `lease unavailable (${reason}); running unleased`);
    emit(opts, { type: "fail-open", reason, waitedMs });
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
            emit(opts, { type: "timeout", refused, waitedMs });
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
/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export function leaseStatus(opts) {
    return statusOf(opts, opts.level());
}
/** Production wiring: the real lease directory and the engine's own sampler and policy. Creates nothing on disk. */
export function defaultLeaseOptions(env = process.env) {
    return {
        dir: leaseDirectory(env),
        level: defaultPressureSampler(env),
        policy: pressurePolicyFromEnv(env),
        inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
        override: pressureOverrideInEffect(env),
    };
}
//# sourceMappingURL=lease.js.map