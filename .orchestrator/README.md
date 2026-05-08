# Self-hosted orchestrator

This directory configures `claude-orchestrator` to run on its own open issues. It dogfoods the tool and lets multiple disjoint issues land in parallel.

## Files

| Path | Purpose |
|---|---|
| `config.yaml` | YAML config — fields documented in `CLAUDE.md` at the repo root. The `issues` array is filled in per wave. |
| `hooks.ts` | `setUpWorktree` and `removeWorktree` overrides. Creates worktrees under `<repo>/worktrees/<slug>` and runs `npm ci` so the agent has working `npm test`/`typecheck`. |
| `prompt.md` | Prompt template used for every issue. Pulls in `gh issue view` to read the canonical body, instructs TDD + local CI gate + `Closes #N` PR + no AI attribution. |
| `run.ts` | Entry point. Imports orchestrator core from compiled `dist/`, hooks from local `./hooks.ts`. |
| `state/` | Runtime state (status files, metadata, run history, counters). Gitignored. Recreated on each run. |

## Prerequisites

- Node 22+ (uses `--experimental-strip-types`).
- `gh` CLI authenticated against `jakebromberg/claude-orchestrator`.
- `dist/` built and committed at HEAD of `main` (the orchestrator imports from `dist/src/...`). Run `npm run build` after any source change before orchestrating.

## Per-wave workflow

1. Edit `config.yaml`. Set the `issues` array to the wave's issue numbers, slugs, dependencies, and descriptions. Existing GitHub issues already carry the description body — keep YAML descriptions short; the agent reads the full body via `gh issue view`.

   ```yaml
   issues:
     - number: 41
       slug: skip-status-propagation
       dependsOn: []
       description: "shouldSkipIssue should write succeeded status so dependents unblock."
     - number: 35
       slug: shell-quote-github-and-create-main
       dependsOn: []
       description: "Apply shellQuote to gh CLI invocations and osascript notification path."
   ```

2. Run the wave:

   ```bash
   npm run orchestrate -- --parallel 2
   ```

   Add `--detach` to background the run, `--notify` for a macOS notification on completion.

3. Watch live:

   ```bash
   npm run orchestrate:dashboard
   # then open http://localhost:3000
   ```

   Or use the terminal watch:

   ```bash
   npm run orchestrate -- --watch
   ```

4. After all issues succeed, merge via:

   ```bash
   npm run orchestrate -- --merge
   ```

   Or merge each PR manually via `gh pr merge --rebase`.

5. Clean up worktrees and branches:

   ```bash
   npm run orchestrate:cleanup
   ```

## Recovery

- A failed issue can be retried with `npm run orchestrate -- --retry-failed`.
- A wave running in `--detach` mode can be reattached with `npm run orchestrate -- --tail`.
- Status snapshots: `npm run orchestrate:status`.

## Debugging a session

Logs and stream-json transcripts go to `state/<config-name>/logs/issue-<N>.log`. The hook-events flag is on by default, so PreToolUse / PostToolUse decisions appear in the transcript for post-mortem analysis.

## Caveats

- Each worktree runs `npm ci` on setup (~30s). Two parallel issues = 1 minute of dependency-install overhead before agent work begins.
- `dist/` must be in sync with `src/` at HEAD of `main`. If the orchestrator behaves oddly after a code change, run `npm run build` and commit before orchestrating.
- Worktrees and `state/` are gitignored. Don't rely on their contents persisting across `--cleanup` runs.
