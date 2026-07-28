/** A node in the dependency graph, identified by composite ref. */
export interface TopoNode {
    /** Composite ref identity, e.g. `"owner/repo#12"` or a bare `"12"`. */
    ref: string;
    /** Refs this node depends on — each must be satisfied before it. */
    deps: string[];
}
/** A node that can never become ready, with the reason and the offending deps. */
export interface BlockedNode {
    ref: string;
    /** The unsatisfiable deps (refs neither done nor reachable in scope). */
    missing: string[];
    /**
     * `"external"` — a missing dep that was never part of the node set (a true
     * outside blocker). `"unreachable"` — a missing dep that *was* in scope but got
     * dropped, so this node is transitively blocked behind another blocked node.
     */
    reason: "external" | "unreachable";
}
/** Result of a single ready-set pass for a given `done` frontier. */
export interface ReadySet {
    /** In-scope, not-done nodes whose every dependency is already done. */
    ready: string[];
    /** Not-done nodes with at least one dep that is neither done nor in scope. */
    blockedExternally: Array<{
        ref: string;
        missing: string[];
    }>;
}
/** A full layered partition of a dependency graph. */
export interface LayeredPartition {
    /** `waves[i]` = refs shippable once every earlier wave (and `done`) is satisfied. */
    waves: string[][];
    /** Nodes dropped because a dependency can never be satisfied. */
    blocked: BlockedNode[];
    /**
     * Nodes left after progress stalled with no external cause: the members of a
     * dependency cycle *plus* any node transitively blocked behind one (a node all
     * of whose remaining paths lead into a cycle can never ship, but is not itself
     * a cycle member). We do not run an SCC pass to separate the two — every caller
     * today treats the whole set as unshippable (`computeWaves` throws on it), so
     * the finer split has no consumer. Revisit if a planner needs to point only at
     * the true cycle members.
     */
    cyclic: string[];
}
/**
 * Ready-set for one `done` frontier: the in-scope, not-done nodes whose every
 * dependency is already satisfied. A node with a dependency that is neither done
 * nor in scope can never be satisfied at this frontier and is reported as
 * `blockedExternally` rather than ready. Order is preserved from `nodes`, so the
 * result is deterministic. Pure.
 */
export declare function readySet(nodes: TopoNode[], done?: Iterable<string>): ReadySet;
/**
 * Layered topological partition over composite refs. Emits one whole ready layer
 * at a time (Kahn), dropping externally-blocked nodes — which can never join a
 * wave — and reclassifying their dependents on the next pass. Whatever remains
 * after a pass that made no progress at all is a dependency cycle.
 *
 * `done` seeds the already-satisfied frontier (merged/closed issues); the sort
 * plans only what is left. `order` gives deterministic within-layer ordering
 * (default: by repo, then number, via {@link compareRefString}). Pure.
 */
export declare function layeredTopoSort(nodes: TopoNode[], options?: {
    done?: Iterable<string>;
    order?: (a: string, b: string) => number;
}): LayeredPartition;
