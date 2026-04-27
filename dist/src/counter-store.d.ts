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
    claim(domain: string, issueNumber: number, width: number, seed: () => number): CounterClaim;
}
export declare class InMemoryCounterStore implements CounterStore {
    private domains;
    claim(domain: string, issueNumber: number, width: number, seed: () => number): CounterClaim;
}
export interface FileCounterStoreOptions {
    /** Lock acquisition timeout in milliseconds. Defaults to 10s. */
    lockTimeoutMs?: number;
}
export declare class FileCounterStore implements CounterStore {
    private configDir;
    private lockTimeoutMs;
    constructor(configDir: string, options?: FileCounterStoreOptions);
    claim(domain: string, issueNumber: number, width: number, seed: () => number): CounterClaim;
}
