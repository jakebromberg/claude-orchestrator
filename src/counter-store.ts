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

export interface CounterClaim {
  /** The captured key as a number (e.g. 57). */
  number: number;
  /** Same number formatted with the configured width (e.g. "0057"). */
  formatted: string;
}

export interface CounterStore {
  /**
   * Atomically claim the next number for `domain` on behalf of `issueNumber`.
   *
   * Idempotent: a second call with the same `(domain, issueNumber)` returns
   * the previously-claimed number. `seed` is consulted only when the domain
   * has no recorded state — its return value becomes the first issued number.
   */
  claim(
    domain: string,
    issueNumber: number,
    width: number,
    seed: () => number,
  ): CounterClaim;
}

interface DomainState {
  next: number;
  claims: Record<string, number>;
}

function format(n: number, width: number): string {
  return String(n).padStart(width, "0");
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

  claim(
    domain: string,
    issueNumber: number,
    width: number,
    seed: () => number,
  ): CounterClaim {
    const before = this.domains.get(domain) ?? null;
    const { state, number } = applyClaim(before, issueNumber, seed);
    this.domains.set(domain, state);
    return { number, formatted: format(number, width) };
  }
}

export class FileCounterStore implements CounterStore {
  constructor(private configDir: string) {}

  claim(
    domain: string,
    issueNumber: number,
    width: number,
    seed: () => number,
  ): CounterClaim {
    if (!/^[A-Za-z0-9_.-]+$/.test(domain)) {
      throw new Error(
        `Invalid domain name "${domain}": must match /^[A-Za-z0-9_.-]+$/`,
      );
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

function withFileLock<T>(lockFile: string, fn: () => T): T {
  const acquired = acquireLock(lockFile);
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

function acquireLock(lockFile: string): boolean {
  const start = Date.now();
  const timeoutMs = 10_000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for counter lock ${lockFile} after ${timeoutMs}ms`,
        );
      }
      const wait = 25 + Math.floor(Math.random() * 50);
      const until = Date.now() + wait;
      while (Date.now() < until) {
        // busy wait — claim is short, no async to yield to
      }
    }
  }
}
