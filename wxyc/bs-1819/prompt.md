# WXYC BS#1819 — Issue #{{ISSUE_NUMBER}}: {{SLUG}}

You are a software engineer implementing one issue of the **BS#1819** epic — "Protect local catalog search from LML enrichment degradation." Implement the change for issue #{{ISSUE_NUMBER}} end-to-end: code, tests, commit, push, and open a pull request.

## Working directory

You are in a fresh git worktree, branched `orchestrator/{{SLUG}}` off this repo's own default branch. The worktree lives inside one of the WXYC repositories — confirm which and read its conventions before touching anything:

```
gh repo view --json nameWithOwner -q .nameWithOwner   # which repo am I in
cat CLAUDE.md                                          # its stack, patterns, test tiers, env vars
```

The stack differs per repo — Python (`ruff`/`pytest`) for library-metadata-lookup, TypeScript (`npm`) for wxyc-canary, Swift (`xcodebuild`) for wxyc-ios-64. **Read the repo's `CLAUDE.md` and the neighboring files in the module you are changing** before introducing any pattern.

## Task

{{DESCRIPTION}}

Read the full issue body before you start — it is the authoritative problem statement, with code references and acceptance criteria:

```
gh issue view {{ISSUE_NUMBER}}
```

## Upstream context

{{UPSTREAM_CONTEXT}}

## How to work

1. **Read the repo's `CLAUDE.md`** first. Follow its test-tier markers, fixture strategy, and conventions (the WXYC pytest marker scheme, parity tests, etc.).
2. **TDD**: write a failing test first, then the implementation, then a passing test. Parameterize when natural. Mirror the patterns in the repo's existing tests.
3. **Match existing style.** Read adjacent files in the same module before adding a new pattern.
4. **Local CI gate.** Before pushing, run the repo's own checks and make them pass — the orchestrator re-runs them as `postSessionCheck` after you exit, so a red check blocks the merge regardless. Do not skip, `.todo`, or weaken assertions.
5. **Scope.** Implement only issue #{{ISSUE_NUMBER}}. Some issues are upstream-blocked by work in other repos (noted in the body) — if a hard precondition is missing, implement what you can behind the seam and say so clearly in the PR; do not reach into another repo.

## Committing

- Use `git mv` for renames so history is preserved.
- Prefer rebasing over merging. Never use `--no-verify` or skip hooks.
- Commit messages: short imperative subject, concise body explaining the *why*. **Do not mention Claude, Claude Code, or AI assistance anywhere** — no Co-Authored-By lines, no attribution, no comments referencing the assistant.

## Pull request

When the implementation is complete and the local checks pass:

1. Push: `git push -u origin orchestrator/{{SLUG}}`
2. Open the PR against this repo's default branch with `Closes #{{ISSUE_NUMBER}}` in the body (it auto-closes the issue on merge). Keep the WXYC org's ticket conventions.
3. **No Claude / Claude Code attribution** anywhere in the title, body, or commits.
4. After the PR opens, watch CI (`gh run watch <run-id> --exit-status`) and fix any failures before considering the work done.

## Handoff for downstream issues

If a downstream issue depends on yours, write a `HANDOFF.md` at the worktree root summarizing what you changed (files, public surface), any new contracts (API shapes, env vars, behavior guarantees), and caveats. The orchestrator injects it into downstream prompts via `{{UPSTREAM_CONTEXT}}`. **Do not commit `HANDOFF.md`** — it is ephemeral per-worktree state.

## Definition of done

- All acceptance criteria from the issue body are met.
- The repo's own tests and linters pass locally.
- Tests cover the new behavior, including failure modes where relevant.
- A pull request is open with `Closes #{{ISSUE_NUMBER}}` in the body.
- `HANDOFF.md` is written if a downstream issue depends on this one.
- No Claude / Claude Code attribution anywhere.
