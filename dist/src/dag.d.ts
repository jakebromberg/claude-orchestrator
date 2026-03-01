import type { Issue, IssueSpec } from "./types.js";
/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues with no dependencies get wave 1. Others get `max(wave of deps) + 1`.
 * Throws if the dependency graph contains a cycle.
 */
export declare function computeWaves(specs: IssueSpec[]): Issue[];
