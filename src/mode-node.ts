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

import type { IssueSpec } from "./types.js";

/** The recognized non-Claude node modes (`issue.mode`). */
export const MODE_NODE_KINDS = ["deploy", "publish", "gate"] as const;

export type ModeNodeKind = (typeof MODE_NODE_KINDS)[number];

/** Whether `issue.mode` names a recognized mode-node kind. */
export function isModeNode(issue: Pick<IssueSpec, "mode">): boolean {
  return (
    issue.mode !== undefined &&
    (MODE_NODE_KINDS as readonly string[]).includes(issue.mode)
  );
}

/**
 * Whether a mode-node runs a configured command (as opposed to a command-less
 * manual gate). A non-mode-node is never a command node, regardless of any
 * `command` field.
 */
export function isCommandNode(issue: Pick<IssueSpec, "mode" | "command">): boolean {
  return isModeNode(issue) && typeof issue.command === "string" && issue.command.length > 0;
}
