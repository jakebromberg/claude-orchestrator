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
export declare function encodeRefForFilename(ref: string): string;
export declare function decodeRefFromFilename(encoded: string): string;
/**
 * Deterministic ordering for issues: by repo, then by number. Numeric (not
 * lexical) within a repo, so `#9` sorts before `#10`. `defaultRepo` resolves
 * repo-less issues so single-repo DAGs order purely numerically as before.
 */
export declare function compareRef(a: RefLike, b: RefLike, defaultRepo?: string): number;
