# HANDOFF: onMergeConflict hook — Phase A (issue #40)

## What changed

**`src/types.ts`**
- Added optional `onMergeConflict?(issue, conflictFiles, baseBranch)` to `OrchestratorHooks`. Returns `Promise<{ resolved: boolean; details?: string }>`. Returning `{ resolved: true }` triggers a single merge retry.

**`src/merge.ts`**
- `mergePrs` is now `async` — all callers must `await` it.
- `MergeDeps` gained two new optional fields: `onMergeConflict` (the hook) and `baseBranch` (defaults to `"main"`).
- When `gh pr merge` throws an error matching `/conflict/i`, and `onMergeConflict` is defined, the hook is invoked with an empty `conflictFiles` array (GitHub's API doesn't enumerate files) and `baseBranch`. If the hook returns `{ resolved: true }`, the merge is retried once. Hook errors are caught and logged as warnings.
- The "rebase remaining candidates" logic was extracted into `rebaseRemaining()` to avoid duplication.

**`src/engine.ts`**
- `runAllWaves` now `await`s `mergePrs` and passes `onMergeConflict` from `config.hooks`.

**`src/create-main.ts`**
- `--merge` CLI mode now `await`s `mergePrs` and passes `onMergeConflict` from `config.hooks`.

**`src/yaml-types.ts`**
- Added `mergeConflictRetry?: { enabled?: boolean; maxAttempts?: number }` to `YamlConfig`. Disabled by default.

**`src/yaml-schema.ts`**
- Added Zod schema for `mergeConflictRetry`.

**`src/yaml-hooks.ts`**
- When `yaml.mergeConflictRetry?.enabled` is true, `deriveHooks` attaches an `onMergeConflict` implementation that runs `claude -p <prompt> --model opus --allowedTools ... --output-format stream-json --verbose` in the issue's worktree via the injected `runCommand`. The prompt contains the issue number, conflict files, and base branch, and tells Claude to resolve conflicts, run tests, and `git push --force-with-lease`. Returns `{ resolved: true }` on exit 0, `{ resolved: false, details }` on failure.

## Contracts the next issue should know about

- **`mergePrs` is async**: any downstream code referencing the old sync signature will need updating.
- **`conflictFiles` is always `[]`** in the default invocation path (GitHub API doesn't report files). Custom hook implementations should inspect `git status` in the worktree.
- **`onMergeConflict` receives `baseBranch` as a parameter** but the default yaml-hooks implementation also has access to `yaml.baseBranch` via closure. The parameter is authoritative for custom hook code.
- **`maxAttempts` is parsed but not enforced** in Phase A — the merge step always retries at most once regardless of the configured value. Phase B/C should enforce the budget and implement the circuit breaker.

## Caveats / intentional deferrals

- **Tool allowlist**: the spawned conflict-resolution session uses `yaml.allowedTools` (falling back to a hardcoded default). Phase B should expose a separate `mergeConflictAllowedTools` field.
- **Retry budget**: `maxAttempts > 1` is ignored. The circuit-breaker (`merge_blocked` status) is out of scope for Phase A.
- **Conflict file detection**: files are not parsed from `gh` output (the API doesn't provide them). A Phase B improvement could do a local `git diff --name-only --diff-filter=U` if the worktree is available.
- **`baseBranch` on `OrchestratorConfig`**: `OrchestratorConfig` does not expose a `baseBranch` field, so the engine passes `undefined` and the hook falls back to `"main"`. Set via `yaml.baseBranch` in the YAML config (the hook closure reads it from there).
