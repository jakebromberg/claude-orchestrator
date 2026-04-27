/**
 * Per-domain monotonically-increasing counters used by the
 * `claimSequentialNumber` coordination primitive (see issue #25).
 *
 * Each domain owns a small JSON document recording the next number to hand out
 * and the (issueNumber → number) claims already made. Claims are idempotent
 * per `(domain, issueNumber)` so retrying a session reuses the same number
 * rather than burning a new slot.
 *
 * The file-backed implementation acquires a per-domain lock file before
 * read-modify-write so a `--detach` orchestrator and an out-of-band CLI claim
 * cannot race.
 */
import fs from "node:fs";
import path from "node:path";
function applyClaim(state, issueNumber, seed) {
    if (state === null) {
        const seeded = seed();
        return {
            state: { next: seeded + 1, claims: { [String(issueNumber)]: seeded } },
            number: seeded,
        };
    }
    const existing = state.claims[String(issueNumber)];
    if (existing !== undefined) {
        return { state, number: existing };
    }
    const issued = state.next;
    return {
        state: {
            next: issued + 1,
            claims: { ...state.claims, [String(issueNumber)]: issued },
        },
        number: issued,
    };
}
export class InMemoryCounterStore {
    domains = new Map();
    claim(domain, issueNumber, seed) {
        const before = this.domains.get(domain) ?? null;
        const { state, number } = applyClaim(before, issueNumber, seed);
        this.domains.set(domain, state);
        return number;
    }
}
export class FileCounterStore {
    configDir;
    lockTimeoutMs;
    constructor(configDir, options = {}) {
        this.configDir = configDir;
        this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    }
    claim(domain, issueNumber, seed) {
        if (!/^[A-Za-z0-9_.-]+$/.test(domain)) {
            throw new Error(`Invalid domain name "${domain}": must match /^[A-Za-z0-9_.-]+$/`);
        }
        const dir = path.join(this.configDir, "counters");
        fs.mkdirSync(dir, { recursive: true });
        const stateFile = path.join(dir, `${domain}.json`);
        const lockFile = `${stateFile}.lock`;
        return withFileLock(lockFile, this.lockTimeoutMs, () => {
            const before = readState(stateFile);
            const { state, number } = applyClaim(before, issueNumber, seed);
            writeStateAtomic(stateFile, state);
            return number;
        });
    }
}
function readState(stateFile) {
    try {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.next !== "number" || typeof parsed.claims !== "object") {
            throw new Error(`Counter state at ${stateFile} is malformed`);
        }
        return { next: parsed.next, claims: parsed.claims ?? {} };
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
function writeStateAtomic(stateFile, state) {
    const tmp = `${stateFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
}
function withFileLock(lockFile, timeoutMs, fn) {
    const acquired = acquireLock(lockFile, timeoutMs);
    try {
        return fn();
    }
    finally {
        if (acquired) {
            try {
                fs.unlinkSync(lockFile);
            }
            catch {
                // best-effort
            }
        }
    }
}
/**
 * Sync sleep without burning CPU. `Atomics.wait` blocks the agent thread for
 * up to `ms` milliseconds; the SharedArrayBuffer is private to this call and
 * never signaled, so the wait always returns by timeout.
 */
function sleepSync(ms) {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
}
/**
 * If a stale lockfile exists for a process that's no longer running, remove
 * it so the next acquisition can proceed. `process.kill(pid, 0)` checks
 * liveness without sending a real signal — it throws ESRCH for dead PIDs.
 * Conservative: any error other than ESRCH (e.g. EPERM for a foreign PID
 * owner) leaves the lock alone so we don't steal it from a real process.
 */
function tryReapStaleLock(lockFile) {
    let raw;
    try {
        raw = fs.readFileSync(lockFile, "utf-8").trim();
    }
    catch {
        return false;
    }
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return false; // PID is alive — lock is real
    }
    catch (err) {
        if (err.code !== "ESRCH")
            return false;
    }
    try {
        fs.unlinkSync(lockFile);
        return true;
    }
    catch {
        return false;
    }
}
function acquireLock(lockFile, timeoutMs) {
    const start = Date.now();
    let staleChecked = false;
    while (true) {
        try {
            const fd = fs.openSync(lockFile, "wx");
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            return true;
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            // Once per acquisition attempt, check if the lock is held by a dead
            // process. If so, reap it and immediately retry.
            if (!staleChecked) {
                staleChecked = true;
                if (tryReapStaleLock(lockFile))
                    continue;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for counter lock ${lockFile} after ${timeoutMs}ms`);
            }
            const wait = 25 + Math.floor(Math.random() * 50);
            sleepSync(wait);
        }
    }
}
//# sourceMappingURL=counter-store.js.map