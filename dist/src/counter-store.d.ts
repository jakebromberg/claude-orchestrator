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
export interface CounterStore {
    /**
     * Atomically claim the next number for `domain` on behalf of `issueNumber`.
     *
     * Idempotent: a second call with the same `(domain, issueNumber)` returns
     * the previously-claimed number without invoking `seed`.
     *
     * For every *new* allocation, `seed` is called and its return value is used
     * as a floor: `Math.max(persisted.next, seed())`. This reconciles the
     * counter against external state (e.g. `origin/<baseBranch>`) so claims
     * remain collision-free even when files land outside the orchestrator run.
     *
     * Returns the raw integer; formatting (zero-padding for display) is the
     * caller's concern since width is a presentation choice tied to the
     * domain's YAML config rather than the store itself.
     */
    claim(domain: string, issueNumber: number, seed: () => number): number;
}
export declare class InMemoryCounterStore implements CounterStore {
    private domains;
    claim(domain: string, issueNumber: number, seed: () => number): number;
}
export interface FileCounterStoreOptions {
    /** Lock acquisition timeout in milliseconds. Defaults to 10s. */
    lockTimeoutMs?: number;
}
export declare class FileCounterStore implements CounterStore {
    private configDir;
    private lockTimeoutMs;
    constructor(configDir: string, options?: FileCounterStoreOptions);
    claim(domain: string, issueNumber: number, seed: () => number): number;
}
