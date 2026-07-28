/**
 * Wave-plan preview — a read-only render of what a run *would* do, without
 * spawning a single session. It answers the questions a cross-repo run raises
 * before you commit compute to it:
 *   - which wave does each issue land in (and are colliding numbers across repos
 *     kept distinct)?
 *   - which nodes are non-Claude mode-nodes (deploy/publish/gate) vs implement
 *     sessions, and what model/effort will each session use?
 *   - where does the run stop for a human — the cross-repo / manual cutover
 *     gates that hold pending `confirmCutover`?
 *
 * Pure (returns a string), so it is unit-tested directly and wired into the CLI
 * as the `--plan` mode. Reads only `config.issues` — which already carry their
 * `wave`/`ref`/`deps` from `computeWaves` (run inside `validateConfig`).
 */
import type { OrchestratorConfig } from "./types.js";
/** The slice of a config the preview needs. */
export type PlanPreviewConfig = Pick<OrchestratorConfig, "name" | "issues" | "defaultModel" | "defaultEffort"> & {
    defaultRepo?: string;
};
/**
 * Render the wave partition for a config as human-readable text.
 *
 * Grouping and ordering are deterministic: waves ascending, issues within a wave
 * by (repo, number). Every identity is the composite `ref`, so two issues that
 * share a number across repos are two distinct rows.
 */
export declare function renderPlanPreview(config: PlanPreviewConfig): string;
