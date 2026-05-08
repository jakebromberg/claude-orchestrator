# HANDOFF: execFileSync migration (issue #36)

## What changed

### Public API changes
- `SeedFromGitDeps.runCommand` (exported from `src/index.ts`) signature changed from `(cmd: string) => string` to `(file: string, args: string[]) => string`. The first argument is the program name (`"git"`), the second is the argument array.

### Internal changes
- `GatherCollisionInputsDeps.runCommand` in `src/collision-check.ts` — same signature change.
- `src/cli-claim.ts` — CLI entry point now uses `execFileSync` instead of `execSync` when invoking `seedFromGit`.
- `src/yaml-hooks.ts` — `DeriveHooksDeps` gained an optional `runGitCommand?: (file: string, args: string[]) => string` field. When present, it is used for all git calls inside `gatherCollisionInputs`. When absent, defaults to `execFileSync`. The existing `runCommand?: (cmd: string, cwd: string) => string` field is unchanged and still used for shell commands (npm test, etc.).
- `src/shell-quote.ts` retained — still used by `github.ts`, `create-main.ts`, and `buildClaimCommand` in `yaml-hooks.ts` (agent-targeted shell strings).

## Decisions / contracts the next issue should know

- Any code that constructs a `SeedFromGitDeps` or `GatherCollisionInputsDeps` (real or mock) must now pass `(file, args)` — a `(cmd: string) => ...` function will fail TypeScript.
- The real implementation in `cli-claim.ts` calls `execFileSync(file, args, { encoding: "utf-8" })`. No shell is involved; path components (spaces, `$`, quotes) are passed through unchanged.
- The `runGitCommand` DI in `DeriveHooksDeps` follows the same `(file, args)` contract. Tests that previously passed `runCommand` for git assertions should now pass `runGitCommand`.

## Caveats

- `SeedFromGitDeps` is exported from `src/index.ts`. Downstream consumers of the npm package that build a `SeedFromGitDeps` object directly will need to update their `runCommand` signature.
- The `runGitCommand` field is new and optional in `DeriveHooksDeps`. Existing callers that pass neither field will get the real `execFileSync` for git calls — correct for production, but tests that relied on the old `runCommand` mock being called for git would silently stop intercepting those calls. Check any `yaml-hooks` consumer tests that count `runCommand` invocations.
