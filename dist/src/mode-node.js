/**
 * Non-Claude DAG node classification.
 *
 * Most issues are implemented by a headless `claude -p` session. A **mode-node**
 * is a first-class DAG node that instead runs a configured command (or, once
 * A5b-2 lands, acts as a pure manual gate) — letting a cross-repo run model
 * "publish wxyc-shared → BS consumes → deploy LML → canary validates" as real
 * nodes with proper dependency ordering. A mode-node has no worktree, no
 * model/effort, and never spawns Claude.
 */
import { repoOfRef } from "./ref.js";
/** The recognized non-Claude node modes (`issue.mode`). */
export const MODE_NODE_KINDS = ["deploy", "publish", "gate"];
/** Whether `issue.mode` names a recognized mode-node kind. */
export function isModeNode(issue) {
    return (issue.mode !== undefined &&
        MODE_NODE_KINDS.includes(issue.mode));
}
/**
 * Whether a mode-node runs a configured command (as opposed to a command-less
 * manual gate). A non-mode-node is never a command node, regardless of any
 * `command` field.
 */
export function isCommandNode(issue) {
    return isModeNode(issue) && typeof issue.command === "string" && issue.command.length > 0;
}
/**
 * A command-less mode-node: a pure manual gate the engine can't run itself, so
 * it stops for human confirmation (the cutover) before releasing dependents.
 */
export function isManualGate(issue) {
    return isModeNode(issue) && !isCommandNode(issue);
}
/**
 * Whether running `issue` requires a manual cutover confirmation, and why —
 * `undefined` when it can release automatically.
 *
 * "Satisfied" is not "consumable" across a repo boundary: a merged upstream PR
 * isn't live downstream until it's published/deployed. So a manual gate is
 * needed when either:
 *   - `issue` is itself a command-less manual gate, or
 *   - `issue` has a **bare cross-repo dependency** — a dep in another repo that
 *     is a plain Claude node. If that cross-repo dep is instead a mode-node, the
 *     cutover is already handled: a command node's command success is the gate,
 *     and a manual gate's own confirmation already served as one.
 *
 * @param lookup resolves a dep ref to its issue (deps that don't resolve are
 *   ignored — the schema already rejects dangling refs).
 */
export function cutoverReason(issue, lookup) {
    if (isManualGate(issue))
        return `manual ${issue.mode} gate`;
    const ownRepo = repoOfRef(issue.ref);
    for (const depRef of issue.deps) {
        if (repoOfRef(depRef) === ownRepo)
            continue; // same repo — no cutover
        const dep = lookup(depRef);
        if (dep && isModeNode(dep))
            continue; // dep's own command/gate is the cutover
        return `cross-repo dependency ${depRef}`;
    }
    return undefined;
}
//# sourceMappingURL=mode-node.js.map