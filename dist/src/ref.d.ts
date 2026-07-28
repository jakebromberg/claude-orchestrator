/** The minimal shape needed to compute a ref: a number and an optional repo. */
export interface RefLike {
    number: number;
    repo?: string;
}
/**
 * Stable identity for an issue. `defaultRepo` (a config-level fallback) fills in
 * for issues that don't declare their own `repo`.
 */
export declare function refOf(spec: RefLike, defaultRepo?: string): string;
/**
 * Normalize one `dependsOn` entry into a dep ref, relative to the issue that
 * declares it. Accepts:
 *   - a number (`1`) or numeric string (`"1"`) → the citing issue's repo
 *   - a leading-hash ref (`"#1"`) → the citing issue's repo
 *   - a fully-qualified cross-repo ref (`"owner/repo#1"`) → used as-is
 */
export declare function normalizeDep(entry: number | string, citing: RefLike, defaultRepo?: string): string;
/**
 * The `owner/repo` portion of a ref, or `undefined` for a bare-number ref.
 * Two refs are cross-repo when their `repoOfRef` values differ — used to detect
 * dependency edges that cross a repository boundary.
 */
export declare function repoOfRef(ref: string): string | undefined;
export declare function encodeRefForFilename(ref: string): string;
export declare function decodeRefFromFilename(encoded: string): string;
/**
 * Deterministic ordering for issues: by repo, then by number. Numeric (not
 * lexical) within a repo, so `#9` sorts before `#10`. `defaultRepo` resolves
 * repo-less issues so single-repo DAGs order purely numerically as before.
 */
export declare function compareRef(a: RefLike, b: RefLike, defaultRepo?: string): number;
/**
 * Deterministic ordering for refs already in string form (`"owner/repo#N"` or a
 * bare `"N"`) — the same repo-then-number ordering as {@link compareRef}, but
 * for callers that hold refs, not `RefLike` objects (the shared topo core and
 * ship-dag's planner). Numeric within a repo (so `#9` sorts before `#10`); bare
 * refs share the empty repo and therefore order purely numerically.
 *
 * Preconditions / caveats:
 * - Assumes a numeric `#N` tail. A non-numeric tail (`"repo#gate"`) yields `NaN`,
 *   which the sort spec treats as "equal" — an unstable, meaningless order. Every
 *   engine ref satisfies this (`IssueSpec.number` is a `number`); an out-of-repo
 *   caller synthesizing non-numeric refs must not rely on their ordering.
 * - Intentionally differs from {@link compareRef} on a bare ref when a
 *   `defaultRepo` is in play: here a bare ref is the empty repo, whereas
 *   `compareRef(a, b, defaultRepo)` resolves it to `defaultRepo`. Only matters
 *   for tie-breaking a set that mixes bare and qualified refs — `computeWaves`
 *   normalizes every ref via `refOf(spec, defaultRepo)` first, so it can't arise
 *   there.
 */
export declare function compareRefString(a: string, b: string): number;
