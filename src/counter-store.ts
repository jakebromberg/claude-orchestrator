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

export interface CounterStore {
  /**
   * Atomically claim the next number for `domain` on behalf of `issueNumber`.
   *
   * Idempotent: a second call with the same `(domain, issueNumber)` returns
   * the previously-claimed number. `seed` is consulted only when the domain
   * has no recorded state — its return value becomes the first issued number.
   *
   * Returns the raw integer; formatting (zero-padding for display) is the
   * caller's concern since width is a presentation choice tied to the
   * domain's YAML config rather than the store itself.
   */
  claim(domain: string, issueNumber: number, seed: () => number): number;
}

interface DomainState {
  next: number;
  claims: Record<string, number>;
}

function applyClaim(
  state: DomainState | null,
  issueNumber: number,
  seed: () => number,
): { state: DomainState; number: number } {
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

export class InMemoryCounterStore implements CounterStore {
  private domains = new Map<string, DomainState>();

  claim(domain: string, issueNumber: number, seed: () => number): number {
    const before = this.domains.get(domain) ?? null;
    const { state, number } = applyClaim(before, issueNumber, seed);
    this.domains.set(domain, state);
    return number;
  }
}

export interface FileCounterStoreOptions {
  /** Lock acquisition timeout in milliseconds. Defaults to 10s. */
  lockTimeoutMs?: number;
}

export class FileCounterStore implements CounterStore {
  private lockTimeoutMs: number;

  constructor(
    private configDir: string,
    options: FileCounterStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  claim(domain: string, issueNumber: number, seed: () => number): number {
    if (!/^[A-Za-z0-9_.-]+$/.test(domain)) {
      throw new Error(
        `Invalid domain name "${domain}": must match /^[A-Za-z0-9_.-]+$/`,
      );
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

function readState(stateFile: string): DomainState | null {
  try {
    const raw = fs.readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.next !== "number" || typeof parsed.claims !== "object") {
      throw new Error(`Counter state at ${stateFile} is malformed`);
    }
    return { next: parsed.next, claims: parsed.claims ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function writeStateAtomic(stateFile: string, state: DomainState): void {
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

function withFileLock<T>(lockFile: string, timeoutMs: number, fn: () => T): T {
  const acquired = acquireLock(lockFile, timeoutMs);
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
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
function sleepSync(ms: number): void {
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
function tryReapStaleLock(lockFile: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, "utf-8").trim();
  } catch {
    return false;
  }
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // PID is alive — lock is real
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile: string, timeoutMs: number): boolean {
  const start = Date.now();
  let staleChecked = false;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Once per acquisition attempt, check if the lock is held by a dead
      // process. If so, reap it and immediately retry.
      if (!staleChecked) {
        staleChecked = true;
        if (tryReapStaleLock(lockFile)) continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for counter lock ${lockFile} after ${timeoutMs}ms`,
        );
      }
      const wait = 25 + Math.floor(Math.random() * 50);
      sleepSync(wait);
    }
  }
}
