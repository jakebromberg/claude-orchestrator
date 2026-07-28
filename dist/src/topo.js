// topo.ts — the shared, composite-keyed topological-sort core.
//
// The single implementation of the layered Kahn partition: used today by the
// engine's `computeWaves` (dag.ts), and — once ship-dag's `planWaves`
// (plan-waves.mjs) imports it in C2b — by that planner too, so the two won't
// drift. Everything is keyed on composite refs
// (opaque strings like `"owner/repo#12"`, or a bare `"12"` in single-repo runs),
// so the same issue number in two repos stays two distinct nodes and a
// cross-repo dependency edge is honored.
//
// The callers wrap this core differently and deliberately are NOT collapsed into
// one call: `computeWaves` throws on any unplaced node and layers file-ownership
// / serial post-processing on top; `planWaves` reports `{waves, blocked, cyclic}`
// gracefully and re-plans against a growing `done` frontier. Only the sort is
// shared — see the plan's "share only the topo core" decision.
//
// Pure, no I/O.
import { compareRefString } from "./ref.js";
/**
 * Ready-set for one `done` frontier: the in-scope, not-done nodes whose every
 * dependency is already satisfied. A node with a dependency that is neither done
 * nor in scope can never be satisfied at this frontier and is reported as
 * `blockedExternally` rather than ready. Order is preserved from `nodes`, so the
 * result is deterministic. Pure.
 */
export function readySet(nodes, done = []) {
    const inScope = new Set(nodes.map((n) => n.ref));
    const doneSet = new Set(done);
    const ready = [];
    const blockedExternally = [];
    for (const node of nodes) {
        if (doneSet.has(node.ref))
            continue;
        const unmet = node.deps.filter((d) => !doneSet.has(d));
        if (unmet.length === 0) {
            ready.push(node.ref);
            continue;
        }
        // A dep that is neither done nor in the current scope can never be satisfied.
        const external = unmet.filter((d) => !inScope.has(d));
        if (external.length > 0) {
            blockedExternally.push({ ref: node.ref, missing: [...new Set(external)] });
        }
    }
    return { ready, blockedExternally };
}
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
export function layeredTopoSort(nodes, options = {}) {
    const order = options.order ?? compareRefString;
    const byRef = new Map(nodes.map((n) => [n.ref, n]));
    const emitted = new Set(options.done ?? []);
    const remaining = new Set([...byRef.keys()].filter((r) => !emitted.has(r)));
    const waves = [];
    const blocked = [];
    while (remaining.size > 0) {
        const remainingNodes = [...remaining].map((r) => byRef.get(r));
        const { ready, blockedExternally } = readySet(remainingNodes, emitted);
        // Externally blocked nodes can never join a wave — drop them out of the loop.
        let removedExternal = false;
        for (const b of blockedExternally) {
            if (!remaining.has(b.ref))
                continue;
            remaining.delete(b.ref);
            removedExternal = true;
            // A missing dep never in the DAG (never a key in `byRef`) is a true external
            // blocker; a missing dep that WAS in scope (but got dropped) makes this node
            // transitively unreachable.
            const reason = b.missing.some((d) => !byRef.has(d))
                ? "external"
                : "unreachable";
            blocked.push({ ref: b.ref, missing: b.missing, reason });
        }
        const layer = ready.filter((r) => remaining.has(r));
        if (layer.length === 0) {
            // Dropping externals can reclassify their dependents on the next pass; only
            // a pass that removed nothing at all is a genuine stall (a cycle remains).
            if (removedExternal)
                continue;
            break;
        }
        layer.sort(order);
        waves.push(layer);
        for (const r of layer) {
            remaining.delete(r);
            emitted.add(r);
        }
    }
    const cyclic = [...remaining].sort(order);
    blocked.sort((a, b) => order(a.ref, b.ref));
    return { waves, blocked, cyclic };
}
//# sourceMappingURL=topo.js.map