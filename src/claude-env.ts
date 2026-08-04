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
 */
export const API_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Set to a truthy value to bill orchestrated sessions to the Anthropic API instead. */
export const USE_API_KEY_ENV_VAR = "CLAUDE_ORCHESTRATOR_USE_API_KEY";

/** Values that read as "off" for {@link USE_API_KEY_ENV_VAR}. */
const FALSY = new Set(["", "0", "false", "no", "off"]);

/**
 * Whether the operator has opted orchestrated sessions back in to API-key billing.
 *
 * @param env - Environment to read; defaults to the current process env.
 */
export function usesApiKeyBilling(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[USE_API_KEY_ENV_VAR];
  return raw !== undefined && !FALSY.has(raw.trim().toLowerCase());
}

/**
 * Build the environment for a child `claude` process.
 *
 * Two things are removed:
 * 1. Every `CLAUDE`-prefixed var, so the child doesn't believe it's a nested
 *    Claude Code session. Matched by prefix rather than by name because Claude
 *    Code and IDE integrations add new ones over time.
 * 2. {@link API_CREDENTIAL_ENV_VARS}, so the session uses the Claude Code login
 *    rather than API credits — unless API-key billing is opted in.
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
    if (key.startsWith("CLAUDE")) delete result[key];
  }
  if (!keepApiKey) {
    for (const key of API_CREDENTIAL_ENV_VARS) delete result[key];
  }

  return result;
}
