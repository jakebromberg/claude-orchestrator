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
/** Deliberation depth passed to `claude --effort`. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Per-issue complexity tag that sets the default effort tier. */
export type Complexity = "mechanical" | "normal" | "complex";
/**
 * Effort tiers in ascending order. Retry escalation walks up this ladder and
 * the Haiku guardrail compares against `high`'s position here.
 */
export declare const EFFORT_LADDER: readonly Effort[];
/** Baseline model when neither the issue nor the config chooses one. */
export declare const DEFAULT_MODEL = "sonnet";
/** Baseline effort when neither an explicit effort, a complexity tag, nor a config default applies. */
export declare const DEFAULT_EFFORT: Effort;
/** Flat inputs to the policy. Both call sites build this via {@link modelEffortInputs}. */
export interface ModelEffortInputs {
    /** Per-issue explicit model (alias like `opus` or a full model id). */
    model?: string;
    /** Per-issue explicit effort tier — the hardest override. */
    effort?: string;
    /** Per-issue complexity tag, used when no explicit effort is set. */
    complexity?: string;
    /** Config-level default model when the issue sets none. */
    defaultModel?: string;
    /** Config-level default effort when neither issue effort nor complexity applies. */
    defaultEffort?: string;
    /**
     * 1-based CI-failure retry attempt; `0`/`undefined` is the initial spawn.
     * Each attempt bumps effort one tier (cumulative, capped at `max`), keeping
     * the model fixed — except the Haiku guardrail below, which may promote to
     * Sonnet once escalation reaches `high`.
     */
    retryAttempt?: number;
}
/** The chosen model + effort for a single spawn. */
export interface ResolvedModelEffort {
    model: string;
    effort: Effort;
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
export declare function resolveModelEffort(inputs: ModelEffortInputs): ResolvedModelEffort;
/** `{ model, effort }` -> `["--model", model, "--effort", effort]`. */
export declare function modelEffortArgs(resolved: ResolvedModelEffort): string[];
/** Per-issue read-only sibling dirs -> repeated `--add-dir <dir>` args. */
export declare function extraDirsArgs(extraDirs?: string[]): string[];
/** Lift the policy inputs off an issue + config, threading an optional retry attempt. */
export declare function modelEffortInputs(issue: {
    model?: string;
    effort?: string;
    complexity?: string;
}, config: {
    defaultModel?: string;
    defaultEffort?: string;
}, retryAttempt?: number): ModelEffortInputs;
/**
 * The full per-issue argument tail every spawn site appends: model/effort plus
 * any `--add-dir` for sibling repos the agent consumes. Placed before a config's
 * generic `claudeArgs`/`getClaudeArgs` output so those still win last (the CLI
 * takes the last `--model`).
 */
export declare function perIssueSpawnArgs(issue: {
    model?: string;
    effort?: string;
    complexity?: string;
    extraDirs?: string[];
}, config: {
    defaultModel?: string;
    defaultEffort?: string;
}, retryAttempt?: number): string[];
