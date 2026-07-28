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
import { compareRef } from "./ref.js";
import { resolveModelEffort, modelEffortInputs } from "./model-effort.js";
import { isModeNode, isManualGate, cutoverReason } from "./mode-node.js";
function plural(n, word) {
    return n === 1 ? word : `${word}s`;
}
/** The per-issue detail column: mode-node kind + command, or resolved model/effort. */
function issueDetail(issue, config) {
    if (isModeNode(issue)) {
        const kind = `[${issue.mode}]`;
        if (isManualGate(issue))
            return `${kind} manual gate`;
        return `${kind} ${issue.command}`;
    }
    const { model, effort } = resolveModelEffort(modelEffortInputs(issue, config));
    return `${model}/${effort}`;
}
function renderIssueLine(issue, config, gateReason) {
    const parts = [`  ${issue.ref}`, issue.slug, issueDetail(issue, config)];
    if (issue.deps.length > 0)
        parts.push(`deps: ${issue.deps.join(", ")}`);
    if (gateReason)
        parts.push(`⚠ HITL: ${gateReason}`);
    return parts.join("  ");
}
/**
 * Render the wave partition for a config as human-readable text.
 *
 * Grouping and ordering are deterministic: waves ascending, issues within a wave
 * by (repo, number). Every identity is the composite `ref`, so two issues that
 * share a number across repos are two distinct rows.
 */
export function renderPlanPreview(config) {
    const { issues } = config;
    const byRef = new Map(issues.map((i) => [i.ref, i]));
    const lookup = (ref) => byRef.get(ref);
    // Which issues stop for a human, and why.
    const gateReason = new Map();
    for (const issue of issues) {
        const reason = cutoverReason(issue, lookup);
        if (reason)
            gateReason.set(issue.ref, reason);
    }
    const waves = [...new Set(issues.map((i) => i.wave))].sort((a, b) => a - b);
    const modeNodeCount = issues.filter((i) => isModeNode(i)).length;
    const gateCount = gateReason.size;
    const lines = [];
    lines.push(`Wave plan: ${config.name}`);
    lines.push(`${issues.length} ${plural(issues.length, "issue")} · ` +
        `${waves.length} ${plural(waves.length, "wave")} · ` +
        `${modeNodeCount} ${plural(modeNodeCount, "mode-node")} · ` +
        `${gateCount} HITL ${plural(gateCount, "gate")}`);
    lines.push("");
    for (const wave of waves) {
        const inWave = issues
            .filter((i) => i.wave === wave)
            .sort((a, b) => compareRef(a, b, config.defaultRepo));
        lines.push(`Wave ${wave}  (${inWave.length} ${plural(inWave.length, "issue")})`);
        for (const issue of inWave) {
            lines.push(renderIssueLine(issue, config, gateReason.get(issue.ref)));
        }
        lines.push("");
    }
    if (gateCount > 0) {
        lines.push(`HITL cutover gates (${gateCount}) — the run holds here until \`confirmCutover\` approves:`);
        // List in the same deterministic (repo, number) order as the waves.
        const gated = issues
            .filter((i) => gateReason.has(i.ref))
            .sort((a, b) => compareRef(a, b, config.defaultRepo));
        for (const issue of gated) {
            lines.push(`  ${issue.ref} (${issue.slug})  ⚠ ${gateReason.get(issue.ref)}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
//# sourceMappingURL=plan-preview.js.map