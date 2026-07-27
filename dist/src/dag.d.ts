import type { Issue, IssueSpec } from "./types.js";
/** Options for `computeWaves`. */
export interface ComputeWavesOptions {
    /**
     * File paths that should not trigger wave serialization when multiple issues
     * declare ownership via `ownsFiles`. Pass the union of the config-level
     * `sharedFiles` allowlist and `appendableFiles` paths here — those files have
     * mechanical merge strategies and do not cause semantic conflicts.
     */
    ignoredOwnsFiles?: string[];
    /**
     * Repo assigned to issues that don't declare their own `repo`, used to build
     * their composite ref. When unset, repo-less issues key on their bare number
     * (single-repo back-compat).
     */
    defaultRepo?: string;
}
/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues are identified by composite ref (`owner/repo#N`, or bare `N` when no
 * repo is known), so the same number in two repos is two distinct nodes and a
 * cross-repo `dependsOn` edge is honored. Issues with no dependencies get wave
 * 1; others get `max(wave of deps) + 1`. If `ownsFiles` is set, issues within
 * the same candidate wave that claim an overlapping file (not covered by
 * `ignoredOwnsFiles`) are slid to the next wave in deterministic (repo, number)
 * order so the earlier issue always runs first.
 * Throws if the dependency graph contains a cycle.
 */
export declare function computeWaves(specs: IssueSpec[], options?: ComputeWavesOptions): Issue[];
