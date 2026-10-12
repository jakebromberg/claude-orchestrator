/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under `heavyCapacity(level, policy)`. Liveness is a live
 * heartbeat (the holder file's mtime, refreshed every 30 s) or a live child PID,
 * so a crashed or killed holder cannot leak a slot. The lease fails open on I/O errors and a long-busy mutex,
 * except at `critical`, where nothing new starts. It never spins.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWithinWindow, tryLockOnce } from "./file-lock.js";
import { leaseEventSink } from "./lease-events.js";
import { defaultPressureSampler, heavyCapacity, leaseDirectory, pressurePolicyFromEnv, } from "./memory-pressure.js";
const MUTEX_STALE_MS = 10_000;
const ORPHAN_MAX_MS = 2 * 60 * 60_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
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
 * The single liveness rule; CO-5's detached holders (#105) extend it. A holder is live while its heartbeat is
 * fresh: `mtimeMs` within 90 s of `nowMs`, in either direction (the mutex's rule, so a small backward clock
 * step cannot reap a live holder, while a heartbeat dated further ahead is stale). Otherwise it is live only
 * while its child PID is alive and within the 2 h orphan bound, and else reaped as `stale-heartbeat`. The
 * wrapper PID is never consulted, so a recycled one cannot pin a slot. A detached holder has no wrapper to
 * beat, so #105 will exempt it from the heartbeat rule by holder kind. `null` is a file that is not a holder record.
 */
function verdict(rec, mtimeMs, nowMs, alive) {
    if (!rec)
        return "corrupt";
    if (isWithinWindow(mtimeMs, nowMs, HEARTBEAT_STALE_MS))
        return "live";
    if (rec.childPid && alive(rec.childPid))
        return Math.abs(nowMs - rec.startedAt) > ORPHAN_MAX_MS ? "orphan-bound" : "live";
    return "stale-heartbeat";
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
/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process. */
const isPid = (n) => Number.isInteger(n) && n > 0;
function parseHolder(text) {
    try {
        const rec = JSON.parse(text);
        return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" ? rec : null;
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
        const mtimeMs = unlessGone(() => statSync(join(dir, name)).mtimeMs);
        if (mtimeMs === undefined)
            continue;
        const v = verdict(rec, mtimeMs, nowMs, isAlive);
        if (v === "live")
            found.live.push({ ...rec, ageSec: Math.round((nowMs - rec.startedAt) / 1000) });
        else
            found.dead.push({ id: name.slice(0, -".json".length), reason: v });
    }
    return found;
}
// Paste-safety for `status` output and the event log, not a security boundary: the lease does no shell parsing. Nothing
// after the first `=` or `://` is recorded, whatever the quoting, so `NAME=value` credentials and `user:token@` URLs are
// cut off. Secrets with neither marker before them (`-p pass`, `Authorization:` headers) are not; such callers pass a label.
const CUT = /=|:\/\//;
/** The caller's label verbatim, else the command up to its first `=` or `://` plus `…`; then truncated. */
function recordedCommand({ command, label }) {
    if (label !== undefined)
        return label.slice(0, COMMAND_MAX);
    const cut = CUT.exec(command);
    return (cut ? `${command.slice(0, cut.index + cut[0].length)}…` : command).slice(0, COMMAND_MAX);
}
function createHolder(opts, meta, command, admission) {
    const now = opts.now ?? Date.now;
    const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const file = join(holdersDir(opts.dir), `${id}.json`);
    const rec = { id, pid: process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
    if (admission.override)
        rec.override = true;
    const write = () => {
        writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
    };
    write();
    let released = false;
    // Unref'd, so it never keeps the process alive. A file found gone was reaped: its heartbeat went stale (this event
    // loop stalled past 90 s, or the wall clock jumped) with no live child recorded. Such a holder stays out of the count
    // for the rest of its run, so neither the beat (utimes never creates) nor setChildPid recreates the file.
    const beat = setInterval(() => {
        try {
            const at = now() / 1000;
            utimesSync(file, at, at);
        }
        catch {
            // Reaped, which is final, or unwritable for now, which the next beat retries.
        }
    }, HEARTBEAT_MS);
    beat.unref();
    return {
        id,
        leased: true,
        admission,
        childEnv: () => ({ CO_LEASE_HOLDER: id }),
        setChildPid(pid) {
            if (released || !isPid(pid))
                return;
            rec.childPid = pid;
            try {
                // Only a file still there is replaced; a reap between this check and the rename is not detected.
                if (unlessGone(() => statSync(file)))
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
            clearInterval(beat);
            try {
                unlinkSync(file);
            }
            catch {
                // Already reaped.
            }
            emit(opts, { type: "release", id, heldMs: now() - rec.startedAt, ...(outcome?.exitCode !== undefined && { exitCode: outcome.exitCode }) });
        },
    };
}
function borrowedHandle(id, level, capacity, live) {
    return { id, leased: true, admission: { waitedMs: 0, level, live, capacity }, childEnv: () => ({ CO_LEASE_HOLDER: id }), setChildPid() { }, release() { } };
}
/**
 * Creates the lease and holders directories (mode 0700), tightens one this user owns to 0700, and throws
 * (an I/O error) on one that is a symlink, not a directory, or another user's. A platform without uids
 * (Windows) skips the ownership check.
 */
function ensureOwnDirs(dir) {
    for (const d of [dir, holdersDir(dir)]) {
        mkdirSync(d, { recursive: true, mode: 0o700 });
        const st = lstatSync(d);
        if (!isOwnDir(st))
            throw new Error(`lease: ${d} is not a directory this user owns`);
        if (st.mode & 0o077)
            chmodSync(d, 0o700);
    }
}
/** The lease's directory rule, given `lstat` stats: a real directory (not a symlink) this user owns. A platform without uids (Windows) skips the ownership check. */
export function isOwnDir(st) {
    return st.isDirectory() && !(process.getuid && st.uid !== process.getuid());
}
/**
 * One admission attempt: sample the level, then count and write holders under the mutex. Caller code
 * (`warn`, `onEvent`) runs only after the mutex is released, so a slow callback cannot outlive its staleness window.
 */
function attempt(opts, meta, waitedMs) {
    const level = opts.level();
    const overridden = opts.level.overridden?.() === true;
    const capacity = heavyCapacity(level, opts.policy);
    const command = recordedCommand(meta);
    const reaped = [];
    let r;
    try {
        ensureOwnDirs(opts.dir);
        const scan = scanHolders(opts);
        if (opts.inheritedHolderId && scan.live.some((h) => h.id === opts.inheritedHolderId)) {
            return { kind: "admitted", handle: borrowedHandle(opts.inheritedHolderId, level, capacity, scan.live.length) };
        }
        const lock = tryLockOnce(join(opts.dir, ".mutex"), { staleAfterMs: MUTEX_STALE_MS, now: opts.now });
        if (!lock)
            return { kind: "busy", level, capacity };
        try {
            const { live, dead } = scanHolders(opts);
            for (const d of dead) {
                rmSync(join(holdersDir(opts.dir), `${d.id}.json`), { force: true });
                reaped.push(d);
            }
            const admission = { waitedMs, level, live: live.length + 1, capacity, ...(overridden && { override: true }) };
            if (live.length < capacity)
                r = { kind: "admitted", handle: createHolder(opts, meta, command, admission) };
            else
                r = { kind: "full", level, capacity };
        }
        finally {
            lock.release();
        }
    }
    catch (error) {
        r = { kind: "error", level, capacity, error };
    }
    for (const { id, reason } of reaped) {
        if (reason === "orphan-bound")
            warn(opts, `lease: reaping holder ${id}: its child outlived the 2 h orphan bound`);
        emit(opts, { type: "reap", id, reason });
    }
    if (r.kind === "admitted")
        emit(opts, { type: "acquire", id: r.handle.id, ...r.handle.admission });
    return r;
}
/** The one default diagnostics writer, shared with the event sink. Messages carry their own `lease:` prefix. */
export function defaultWarn(msg) {
    process.stderr.write(`${msg}\n`);
}
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
function failOpen(opts, level, capacity, waitedMs, reason, error) {
    warn(opts, `lease: unavailable (${reason}); running unleased`);
    const { code, message } = (error ?? {});
    emit(opts, { type: "fail-open", reason, waitedMs, ...(code !== undefined && { code }), ...(message !== undefined && { message }) });
    return { id: null, leased: false, admission: { waitedMs, level, live: 0, capacity }, childEnv: () => ({}), setChildPid() { }, release() { } };
}
/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. */
export function tryAcquireLease(opts, meta) {
    const r = attempt(opts, meta, 0);
    if (r.kind === "admitted")
        return r.handle;
    return r.kind === "error" && r.level !== "critical" ? failOpen(opts, r.level, r.capacity, 0, "io-error", r.error) : null;
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
                return failOpen(opts, r.level, r.capacity, waitedMs, "io-error", r.error);
            if (busySince !== undefined && now() - busySince >= FAIL_OPEN_MS)
                return failOpen(opts, r.level, r.capacity, waitedMs, "mutex-busy");
        }
        const status = r.kind === "error" ? { level: r.level, capacity: r.capacity, live: [] } : statusOf(opts, r.level);
        const refuse = (refused, level, live) => {
            emit(opts, { type: "timeout", refused, waitedMs, ...(refused === "stopped" && { level }) });
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
/**
 * Production wiring: the real lease directory, the engine's own sampler and policy, and the `events.jsonl` sink. Creates nothing on disk.
 * `overrides.level` replaces the sampler (none is built), and `overrides.warn` is the one writer for the lease, the sink,
 * the policy and the sampler it builds; without it each keeps its stderr default.
 */
export function defaultLeaseOptions(env = process.env, overrides = {}) {
    // One non-throwing writer for every consumer; policy and sampler lines get a `memory-pressure:` tag since the writer is not stderr's tagged default.
    const inject = overrides.warn;
    const safe = (msg) => {
        try {
            inject?.(msg);
        }
        catch {
            // A diagnostics writer must never change what the lease does.
        }
    };
    const warn = inject && safe;
    const tagged = warn && ((msg) => warn(`memory-pressure: ${msg}`));
    const dir = leaseDirectory(env);
    return {
        dir,
        level: overrides.level ?? defaultPressureSampler(env, { log: tagged }),
        policy: pressurePolicyFromEnv(env, tagged),
        inheritedHolderId: env.CO_LEASE_HOLDER || undefined,
        onEvent: leaseEventSink(dir, { warn }),
        warn,
    };
}
//# sourceMappingURL=lease.js.map