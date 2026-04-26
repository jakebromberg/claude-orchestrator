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
function format(n, width) {
    return String(n).padStart(width, "0");
}
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
    claim(domain, issueNumber, width, seed) {
        const before = this.domains.get(domain) ?? null;
        const { state, number } = applyClaim(before, issueNumber, seed);
        this.domains.set(domain, state);
        return { number, formatted: format(number, width) };
    }
}
export class FileCounterStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    claim(domain, issueNumber, width, seed) {
        if (!/^[A-Za-z0-9_.-]+$/.test(domain)) {
            throw new Error(`Invalid domain name "${domain}": must match /^[A-Za-z0-9_.-]+$/`);
        }
        const dir = path.join(this.configDir, "counters");
        fs.mkdirSync(dir, { recursive: true });
        const stateFile = path.join(dir, `${domain}.json`);
        const lockFile = `${stateFile}.lock`;
        return withFileLock(lockFile, () => {
            const before = readState(stateFile);
            const { state, number } = applyClaim(before, issueNumber, seed);
            writeStateAtomic(stateFile, state);
            return { number, formatted: format(number, width) };
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
function withFileLock(lockFile, fn) {
    const acquired = acquireLock(lockFile);
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
function acquireLock(lockFile) {
    const start = Date.now();
    const timeoutMs = 10_000;
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
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for counter lock ${lockFile} after ${timeoutMs}ms`);
            }
            const wait = 25 + Math.floor(Math.random() * 50);
            const until = Date.now() + wait;
            while (Date.now() < until) {
                // busy wait — claim is short, no async to yield to
            }
        }
    }
}
//# sourceMappingURL=counter-store.js.map