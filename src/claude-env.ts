/**
 * Environment preparation for spawned `claude` CLI sessions.
 *
 * The orchestrator drives Claude Code (the `claude` CLI), never the Anthropic
 * SDK. But the CLI resolves credentials from the environment before falling
 * back to the interactive login, so an `ANTHROPIC_API_KEY` exported in the
 * operator's shell silently reroutes every orchestrated session onto pay-per-token
 * API billing. Sessions started that way report
 * `"apiKeySource":"ANTHROPIC_API_KEY"` in their stream-json init event.
 *
 * Every site that launches `claude` therefore builds its child environment
 * here, so sessions default to the Claude Code login (subscription) and the
 * opt-in to API-key billing lives in exactly one place.
 */

/**
 * Env vars that make the `claude` CLI authenticate as an API-key user and bill
 * API credits. Stripped from child sessions unless API-key billing is opted in.
 *
 * Deliberately narrow: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and friends are
 * routing/config, not credentials, and are passed through untouched.
 *
 * Two known gaps, both left open on purpose:
 * - `ANTHROPIC_CUSTOM_HEADERS` can smuggle a credential (`x-api-key: ...`), but
 *   it also carries ordinary headers a proxy may require, so scrubbing it would
 *   break more setups than it protects. An operator using it for auth should set
 *   {@link USE_API_KEY_ENV_VAR} to make that explicit.
 * - Stripping `ANTHROPIC_AUTH_TOKEN` while keeping `ANTHROPIC_BASE_URL` leaves an
 *   LLM-gateway setup half-configured; those operators must opt in as well. The
 *   alternative — keeping credentials whenever a base URL is set — would infer
 *   billing intent from a routing variable and fail open on spend, which is the
 *   failure this module exists to prevent. {@link authBanner} names the dropped
 *   variable so the breakage explains itself.
 */
export const API_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Credential that survives the `CLAUDE*` sweep below.
 *
 * `claude setup-token` mints this for headless and CI use of a Claude
 * subscription, so it is the login sessions are meant to fall back to — the
 * opposite of a nested-session marker.
 */
const PRESERVED_CLAUDE_ENV_VARS = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Set to `1`/`true`/`yes`/`on` to bill orchestrated sessions to the Anthropic API instead. */
export const USE_API_KEY_ENV_VAR = "CLAUDE_ORCHESTRATOR_USE_API_KEY";

/**
 * Values that read as "on" for {@link USE_API_KEY_ENV_VAR}.
 *
 * An allowlist rather than a denylist: this flag exists to prevent unintended
 * spend, so an unrecognised value (`disabled`, `none`, a typo) must fail closed.
 */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the operator has opted orchestrated sessions back in to API-key billing.
 *
 * @param env - Environment to read; defaults to the current process env.
 */
export function usesApiKeyBilling(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[USE_API_KEY_ENV_VAR];
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * `execSync` options for a shell command that launches `claude`.
 *
 * Both exec-based launch sites (`--decompose` and the `onMergeConflict`
 * resolver) go through this, so the scrubbed environment can't be dropped by a
 * refactor of either call site independently.
 *
 * @param extra.cwd - Working directory, when the command needs one.
 * @param extra.input - stdin to feed the command.
 */
export function claudeExecOptions(
  extra: { cwd?: string; input?: string } = {},
): { encoding: "utf-8"; env: NodeJS.ProcessEnv; cwd?: string; input?: string } {
  return {
    encoding: "utf-8",
    env: claudeSessionEnv(),
    ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}),
    ...(extra.input !== undefined ? { input: extra.input } : {}),
  };
}

/**
 * The auth line printed at the start of a run.
 *
 * Billing mode is otherwise invisible while a run is under way — the only
 * in-band signal is `apiKeySource` buried in each session's stream-json log —
 * and a session that can't authenticate is baffling unless the run said which
 * credential it dropped. So when a credential is present but scrubbed, name it.
 *
 * @param env - Environment to describe; defaults to the current process env.
 * @returns Log level and message. `warn` only when spend is being incurred.
 */
export function authBanner(env: NodeJS.ProcessEnv = process.env): {
  level: "info" | "warn";
  message: string;
} {
  if (usesApiKeyBilling(env)) {
    return {
      level: "warn",
      message:
        `Auth: Anthropic API key (${USE_API_KEY_ENV_VAR} is set) — sessions bill API credits`,
    };
  }

  const ignored = API_CREDENTIAL_ENV_VARS.filter((key) => env[key]);
  if (ignored.length > 0) {
    return {
      level: "info",
      message:
        `Auth: Claude Code login — ${ignored.join(" and ")} ignored ` +
        `(set ${USE_API_KEY_ENV_VAR}=1 to bill API credits instead)`,
    };
  }

  return {
    level: "info",
    message: "Auth: Claude Code login (sessions count against your Claude subscription)",
  };
}

/**
 * Build the environment for a child `claude` process.
 *
 * Two things are removed:
 * 1. Every `CLAUDE`-prefixed var except {@link PRESERVED_CLAUDE_ENV_VARS}, so the
 *    child doesn't believe it's a nested Claude Code session. Matched by prefix
 *    rather than by name because Claude Code and IDE integrations add new ones
 *    over time.
 * 2. {@link API_CREDENTIAL_ENV_VARS}, so the session uses the Claude Code login
 *    rather than API credits — unless API-key billing is opted in.
 *
 * Note the scrub reaches everything the session itself runs: a command the agent
 * executes through its Bash tool sees this environment too. The `postSessionCheck`
 * runner is the deliberate exception (see `yaml-hooks.ts`).
 *
 * @param env - Environment to derive from; defaults to the current process env. Not mutated.
 * @param options.useApiKey - Force API-key billing on (`true`) or off (`false`).
 *   Defaults to {@link usesApiKeyBilling} read from `env`.
 * @returns A fresh environment object safe to hand to `spawn`/`execSync`.
 */
export function claudeSessionEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { useApiKey?: boolean } = {},
): NodeJS.ProcessEnv {
  const keepApiKey = options.useApiKey ?? usesApiKeyBilling(env);
  const result: NodeJS.ProcessEnv = { ...env };

  for (const key of Object.keys(result)) {
    if (key.startsWith("CLAUDE") && !PRESERVED_CLAUDE_ENV_VARS.has(key)) {
      delete result[key];
    }
  }
  if (!keepApiKey) {
    for (const key of API_CREDENTIAL_ENV_VARS) delete result[key];
  }

  return result;
}
