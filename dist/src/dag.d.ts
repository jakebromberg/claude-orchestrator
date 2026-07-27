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
}
/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues with no dependencies get wave 1. Others get `max(wave of deps) + 1`.
 * If `ownsFiles` is set on any issue, issues within the same candidate wave
 * that claim an overlapping file (not covered by `ignoredOwnsFiles`) are slid
 * to the next wave in ascending issue-number order so that the lower-numbered
 * issue always runs first.
 * Throws if the dependency graph contains a cycle.
 */
export declare function computeWaves(specs: IssueSpec[], options?: ComputeWavesOptions): Issue[];
