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
import type { Issue, IssueSpec } from "./types.js";
/** The recognized non-Claude node modes (`issue.mode`). */
export declare const MODE_NODE_KINDS: readonly ["deploy", "publish", "gate"];
export type ModeNodeKind = (typeof MODE_NODE_KINDS)[number];
/** Whether `issue.mode` names a recognized mode-node kind. */
export declare function isModeNode(issue: Pick<IssueSpec, "mode">): boolean;
/**
 * Whether a mode-node runs a configured command (as opposed to a command-less
 * manual gate). A non-mode-node is never a command node, regardless of any
 * `command` field.
 */
export declare function isCommandNode(issue: Pick<IssueSpec, "mode" | "command">): boolean;
/**
 * A command-less mode-node: a pure manual gate the engine can't run itself, so
 * it stops for human confirmation (the cutover) before releasing dependents.
 */
export declare function isManualGate(issue: Pick<IssueSpec, "mode" | "command">): boolean;
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
 * @param lookup resolves a dep ref to its issue. An unresolved *cross-repo* dep
 *   is treated conservatively as a cutover (gated); an unresolved *same-repo*
 *   dep is ignored. Dangling refs can't occur at runtime — the schema rejects
 *   them — so `lookup` returns a node for every real dep.
 */
export declare function cutoverReason(issue: Issue, lookup: (ref: string) => Issue | undefined): string | undefined;
