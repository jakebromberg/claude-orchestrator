/**
 * Machine-wide lease for heavy commands (full test suites, `tsc`, `npm ci`).
 * Holders are files in `<dir>/holders/`; a request is admitted while the live
 * holder count is under `heavyCapacity(level, policy)`. Liveness is a live
 * heartbeat (the holder file's mtime, refreshed every 30 s) or a live child PID,
 * so a crashed or killed holder cannot leak a slot. A detached holder (hook mode) is live while its session PID is
 * alive and its `expiresAt` has not passed. The lease fails open on I/O errors and a long-busy mutex,
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
/** A waiter's ticket is eligible while its mtime is this close to the reader's clock; a waiter refreshes it on every poll. */
const TICKET_FRESH_MS = 15_000;
/** The longest a detached holder may be set to live: the largest Bash call timeout (10 min) plus hook mode's 60 s grace. */
export const DETACHED_TTL_MAX_MS = 660_000;
/** A detached holder's id, and the only ids `releaseHolder` accepts, so neither can name a path outside `holders/` or overrun a file name. */
const HOLDER_ID = /^[\w-]{1,160}$/;
const holdersDir = (dir) => join(dir, "holders");
const waitingDir = (dir) => join(dir, "waiting");
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
 * The single liveness rule. A detached holder (`expiresAt` set) is judged first and never by its heartbeat: it is
 * `expired` once `nowMs >= expiresAt` (so a forward clock step frees the slot early), or when `expiresAt` is more
 * than 660 s plus the 90 s heartbeat window ahead (so a backward step of up to 90 s never reaps a holder written
 * within the 660 s cap, and a larger one frees it early), else live while its
 * session PID (`pid`) is alive, and `dead-session` when not. Any other holder is live while its heartbeat is
 * fresh: `mtimeMs` within 90 s of `nowMs`, in either direction (the mutex's rule, so a small backward clock
 * step cannot reap a live holder, while a heartbeat dated further ahead is stale). Otherwise it is live only
 * while its child PID is alive and within the 2 h orphan bound, and else reaped as `stale-heartbeat`. The
 * wrapper PID is never consulted, so a recycled one cannot pin a slot. `null` is a file that is not a holder record.
 */
function verdict(rec, mtimeMs, nowMs, alive) {
    if (!rec)
        return "corrupt";
    if (rec.expiresAt !== undefined) {
        if (nowMs >= rec.expiresAt || rec.expiresAt - nowMs > DETACHED_TTL_MAX_MS + HEARTBEAT_STALE_MS)
            return "expired";
        return alive(rec.pid) ? "live" : "dead-session";
    }
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
/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process, and `process.kill` rejects 2^31 and above. */
export const isPid = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;
function parseHolder(text) {
    try {
        const rec = JSON.parse(text);
        return isPid(rec?.pid) && (rec.childPid === undefined || isPid(rec.childPid)) && typeof rec.startedAt === "number" && (rec.expiresAt === undefined || Number.isFinite(rec.expiresAt)) ? rec : null;
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
function parseTicket(text) {
    try {
        const t = JSON.parse(text);
        return Number.isFinite(t?.seq) && typeof t.id === "string" && isPid(t.pid) ? t : null;
    }
    catch {
        return null;
    }
}
/**
 * Under the mutex: removes the tickets of dead processes and unparseable files, and returns the rest. A ticket is
 * `eligible` while its mtime is within 15 s of the clock; a stale one (its waiter was stopped) is passed over, not reaped,
 * and keeps its `seq` for when the waiter resumes.
 */
function scanTickets(opts) {
    const { isAlive = pidAlive, now = Date.now } = opts;
    const dir = waitingDir(opts.dir);
    const nowMs = now();
    const found = [];
    for (const name of (unlessGone(() => readdirSync(dir)) ?? []).filter((n) => n.endsWith(".json"))) {
        const text = unlessGone(() => readFileSync(join(dir, name), "utf8"));
        const mtimeMs = unlessGone(() => statSync(join(dir, name)).mtimeMs);
        if (text === undefined || mtimeMs === undefined)
            continue;
        const t = parseTicket(text);
        if (!t || !isAlive(t.pid))
            rmSync(join(dir, name), { force: true });
        else
            found.push({ ...t, eligible: isWithinWindow(mtimeMs, nowMs, TICKET_FRESH_MS) });
    }
    return found;
}
/** Writes or refreshes a ticket, dating it on the lease clock before the rename so a reader never sees it with another mtime. */
function writeTicket(opts, t) {
    const file = join(waitingDir(opts.dir), `${t.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(t), { mode: 0o600 });
    const at = (opts.now ?? Date.now)() / 1000;
    utimesSync(`${file}.tmp`, at, at);
    renameSync(`${file}.tmp`, file);
}
const removeTicket = (opts, id) => rmSync(join(waitingDir(opts.dir), `${id}.json`), { force: true });
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
    const { detached } = meta;
    const id = detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
    const file = join(holdersDir(opts.dir), `${id}.json`);
    const rec = { id, pid: detached?.sessionPid ?? process.pid, command, cwd: meta.cwd, startedAt: now(), level: admission.level };
    if (detached)
        rec.expiresAt = detached.expiresAt;
    if (admission.override)
        rec.override = true;
    const write = () => {
        writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
    };
    write();
    let released = false;
    // A detached holder gets no heartbeat: its session PID and `expiresAt` keep it live.
    // Unref'd, so it never keeps the process alive. A file found gone was reaped: its heartbeat went stale (this event
    // loop stalled past 90 s, or the wall clock jumped) with no live child recorded. Such a holder stays out of the count
    // for the rest of its run, so neither the beat (utimes never creates) nor setChildPid recreates the file.
    const beat = detached ? undefined : setInterval(() => {
        try {
            const at = now() / 1000;
            utimesSync(file, at, at);
        }
        catch {
            // Reaped, which is final, or unwritable for now, which the next beat retries.
        }
    }, HEARTBEAT_MS);
    beat?.unref();
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
 * Creates the lease, holders and waiting directories (mode 0700), tightens one this user owns to 0700, and throws
 * (an I/O error) on one that is a symlink, not a directory, or another user's. A platform without uids
 * (Windows) skips the ownership check.
 */
function ensureOwnDirs(dir) {
    for (const d of [dir, holdersDir(dir), waitingDir(dir)]) {
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
 * One admission attempt: sample the level, then count and write holders under the mutex. Admission is FIFO: a waiter
 * (`ticketId` set) is admitted when fewer eligible tickets are ahead of its own than there are free slots, and a refused
 * one writes or refreshes its ticket. Without a `ticketId` (`tryAcquireLease`) it is admitted only when a slot is free
 * and no eligible ticket waits, and writes none. Caller code (`warn`, `onEvent`) runs only after the mutex is released,
 * so a slow callback cannot outlive its staleness window.
 */
function attempt(opts, meta, waitedMs, ticketId) {
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
            // A second hook install for the same call acquires the id the first one holds: that call is already admitted.
            if (meta.detached && live.some((h) => h.id === meta.detached.id))
                r = { kind: "admitted", handle: borrowedHandle(meta.detached.id, level, capacity, live.length), borrowed: true };
            else {
                const line = scanTickets(opts);
                const mine = line.find((t) => t.id === ticketId);
                const seq = mine?.seq ?? Math.max(0, ...line.map((t) => t.seq)) + 1;
                const ahead = line.filter((t) => t.eligible && t.id !== ticketId && (ticketId === undefined || t.seq < seq)).length;
                const free = capacity - live.length;
                if (ahead < (ticketId === undefined ? Math.min(free, 1) : free)) {
                    r = { kind: "admitted", handle: createHolder(opts, meta, command, admission) };
                    if (mine)
                        removeTicket(opts, mine.id);
                }
                else {
                    if (ticketId !== undefined)
                        writeTicket(opts, { seq, id: ticketId, pid: process.pid, label: command, gated: false });
                    r = { kind: "full", level, capacity };
                }
            }
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
    if (r.kind === "admitted" && !r.borrowed)
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
/** Throws on a detached id, session PID or `expiresAt` that would write a holder the next scan reaps as corrupt: a caller's bug, not an I/O error to fail open on. */
function checkDetached(meta) {
    const d = meta.detached;
    if (!d)
        return;
    if (!HOLDER_ID.test(d.id))
        throw new TypeError(`lease: detached holder id ${JSON.stringify(d.id)} is not 1 to 160 of [A-Za-z0-9_-]`);
    if (!isPid(d.sessionPid))
        throw new TypeError(`lease: detached session PID ${String(d.sessionPid)} is not a positive integer below 2^31`);
    if (!Number.isFinite(d.expiresAt))
        throw new TypeError(`lease: detached expiresAt ${String(d.expiresAt)} is not a finite number`);
}
/** A single non-blocking attempt: a handle, or `null` when not admitted this poll. Throws a `TypeError` on an invalid detached id, session PID or `expiresAt`. */
export function tryAcquireLease(opts, meta) {
    checkDetached(meta);
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
 * Polls (3 s ± 1 s, never spinning) until admitted, in the order waiters arrived: each waits behind a ticket in
 * `<dir>/waiting/`, which it removes when it is admitted, when it gives up and when this returns or throws. `stopWhen` is checked on every poll, and a stop is confirmed with a
 * `level.fresh()` re-read before it is returned, so one stale cached sample cannot end a wave. `onWait` runs on each poll
 * that neither admits nor refuses, and also receives `waitedMs`: the wait so far, measured on `LeaseOptions.now` the
 * same way as an admission's or refusal's `waitedMs`, so a progress line can throttle on it without a clock of its own.
 */
export async function acquireLease(opts, meta, wait = {}) {
    checkDetached(meta);
    const ticketId = meta.detached?.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
        return await pollForLease(opts, meta, wait, ticketId);
    }
    finally {
        try {
            removeTicket(opts, ticketId);
        }
        catch {
            // A ticket that stays is reaped once this process exits.
        }
    }
}
async function pollForLease(opts, meta, wait, ticketId) {
    const { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS } = opts;
    const start = now();
    let busySince;
    for (;;) {
        const waitedMs = now() - start;
        const r = attempt(opts, meta, waitedMs, ticketId);
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
        wait.onWait?.({ ...status, waitedMs });
        const jittered = Math.round(pollMs * (2 / 3 + Math.random() * (2 / 3)));
        await sleep(wait.maxWaitMs === undefined ? jittered : Math.min(jittered, wait.maxWaitMs - waitedMs));
    }
}
/**
 * Releases a detached holder by id from any process; idempotent. Returns whether a holder file was removed, and emits
 * one `release` event with `heldMs` only then. It removes only a valid detached record (one with `expiresAt`): a
 * wrapper's own holder and a corrupt file are left to their owner and the reaper. An id that is not 1 to 160 of
 * `[A-Za-z0-9_-]` names no holder, and a holders or lease directory that breaks the directory rule (a symlink, or
 * another user's) is not read, so neither can reach a file outside `holders/`.
 */
export function releaseHolder(opts, id) {
    if (!HOLDER_ID.test(id))
        return false;
    const dir = holdersDir(opts.dir);
    const ownDir = (d) => {
        const st = unlessGone(() => lstatSync(d));
        return st !== undefined && isOwnDir(st);
    };
    if (!ownDir(opts.dir) || !ownDir(dir))
        return false;
    const file = join(dir, `${id}.json`);
    const text = unlessGone(() => readFileSync(file, "utf8"));
    const rec = text === undefined ? null : parseHolder(text);
    if (rec?.expiresAt === undefined || unlessGone(() => (unlinkSync(file), true)) === undefined)
        return false;
    emit(opts, { type: "release", id, heldMs: (opts.now ?? Date.now)() - rec.startedAt });
    return true;
}
/** Read-only: creates nothing, reaps nothing. Reports no live holders when the directory cannot be read. */
export function leaseStatus(opts) {
    return statusOf(opts, opts.level());
}
/**
 * Production wiring: the real lease directory, the engine's own sampler and policy, and the `events.jsonl` sink. Creates nothing on disk.
 * `overrides.level` replaces the sampler (none is built), and `overrides.warn` is the one writer for the lease, the sink,
 * the policy and the sampler it builds; without it each keeps its stderr default.
 * The writer is wrapped once so it cannot change what the lease does: a writer that throws is silenced (the line is dropped and nothing reports it), so pass a bound function,
 * and the returned `warn` is that wrapper, not the caller's function.
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