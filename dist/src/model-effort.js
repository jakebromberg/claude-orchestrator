/**
 * Per-issue model & effort policy for headless Claude sessions.
 *
 * The orchestrator runs one implement session per issue. Rather than a single
 * global model for the whole run, each issue picks a model and an effort tier
 * from its own `model`/`effort`/`complexity` fields, falling back to the
 * config-level `defaultModel`/`defaultEffort`, then to the built-in
 * Sonnet/medium baseline. CI-failure retries escalate effort one tier per
 * attempt. A guardrail keeps weak models off high-effort work.
 *
 * This module is the pure policy core (no I/O). {@link resolveModelEffort} is
 * table-tested; the engine, the YAML merge-conflict resolver, and any custom
 * config all funnel through {@link perIssueSpawnArgs}.
 */
/**
 * Effort tiers in ascending order. Retry escalation walks up this ladder and
 * the Haiku guardrail compares against `high`'s position here.
 */
export const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
/** Complexity tag -> base effort tier (matrix: mechanical→low, normal→medium, complex→high). */
const COMPLEXITY_EFFORT = {
    mechanical: "low",
    normal: "medium",
    complex: "high",
};
/** Baseline model when neither the issue nor the config chooses one. */
export const DEFAULT_MODEL = "sonnet";
/** Baseline effort when neither an explicit effort, a complexity tag, nor a config default applies. */
export const DEFAULT_EFFORT = "medium";
/** First tier the Haiku guardrail treats as "too much effort for a weak model". */
const GUARDRAIL_EFFORT_FLOOR = "high";
function isEffort(value) {
    return EFFORT_LADDER.includes(value);
}
function isComplexity(value) {
    return value === "mechanical" || value === "normal" || value === "complex";
}
/** A model is "Haiku-class" if its alias or full id mentions haiku. */
function isHaiku(model) {
    return /haiku/i.test(model);
}
/**
 * Resolve the model and effort for one session from its per-issue fields and
 * the config defaults.
 *
 * Precedence:
 * - model: `issue.model` -> `defaultModel` -> `sonnet`.
 * - effort: explicit `issue.effort` -> `complexity` tier -> `defaultEffort` -> `medium`,
 *   then escalated one tier per `retryAttempt` (capped at `max`).
 *
 * Guardrail: a Haiku-class model resolved to `high` effort or above is promoted
 * to Sonnet instead — a weak model straining is worse per token than a stronger
 * model deliberating less.
 */
export function resolveModelEffort(inputs) {
    const model = inputs.model ?? inputs.defaultModel ?? DEFAULT_MODEL;
    let baseEffort;
    if (inputs.effort && isEffort(inputs.effort)) {
        baseEffort = inputs.effort;
    }
    else if (inputs.complexity && isComplexity(inputs.complexity)) {
        baseEffort = COMPLEXITY_EFFORT[inputs.complexity];
    }
    else if (inputs.defaultEffort && isEffort(inputs.defaultEffort)) {
        baseEffort = inputs.defaultEffort;
    }
    else {
        baseEffort = DEFAULT_EFFORT;
    }
    const attempts = Math.max(0, inputs.retryAttempt ?? 0);
    const escalatedIdx = Math.min(EFFORT_LADDER.indexOf(baseEffort) + attempts, EFFORT_LADDER.length - 1);
    const effort = EFFORT_LADDER[escalatedIdx];
    const model_ = isHaiku(model) && EFFORT_LADDER.indexOf(effort) >= EFFORT_LADDER.indexOf(GUARDRAIL_EFFORT_FLOOR)
        ? DEFAULT_MODEL
        : model;
    return { model: model_, effort };
}
/** `{ model, effort }` -> `["--model", model, "--effort", effort]`. */
export function modelEffortArgs(resolved) {
    return ["--model", resolved.model, "--effort", resolved.effort];
}
/** Per-issue read-only sibling dirs -> repeated `--add-dir <dir>` args. */
export function extraDirsArgs(extraDirs) {
    return (extraDirs ?? []).flatMap((dir) => ["--add-dir", dir]);
}
/** Lift the policy inputs off an issue + config, threading an optional retry attempt. */
export function modelEffortInputs(issue, config, retryAttempt) {
    return {
        model: issue.model,
        effort: issue.effort,
        complexity: issue.complexity,
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        retryAttempt,
    };
}
/**
 * The full per-issue argument tail every spawn site appends: model/effort plus
 * any `--add-dir` for sibling repos the agent consumes. Placed before a config's
 * generic `claudeArgs`/`getClaudeArgs` output so those still win last (the CLI
 * takes the last `--model`).
 */
export function perIssueSpawnArgs(issue, config, retryAttempt) {
    const resolved = resolveModelEffort(modelEffortInputs(issue, config, retryAttempt));
    return [...modelEffortArgs(resolved), ...extraDirsArgs(issue.extraDirs)];
}
//# sourceMappingURL=model-effort.js.map