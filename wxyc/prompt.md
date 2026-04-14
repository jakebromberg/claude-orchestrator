You are implementing a task in the WXYC ETL Pipeline Unification project. This is a 25-task effort across 9 repos that consolidates shared Rust utilities into `wxyc-etl` and migrates Python and Rust consumers to use them.

## Context

Your working directory is a git worktree for the target repo. All WXYC repos are available under `/Users/jake/Developer/WXYC` via `--add-dir`.

## Your task

**Issue: {{DESCRIPTION}}**

Read the full implementation plan from the GitHub issue body:

```bash
gh issue view {{ISSUE_NUMBER}} --repo WXYC/{{SLUG}} --json body --jq .body
```

The issue body contains the complete specification, acceptance criteria, and implementation notes.

## Pre-implementation checklist

1. **Read the issue body** in full. It is the single source of truth for this task.
2. **Read the repo's CLAUDE.md** for coding conventions, test commands, and branching rules.
3. **Check dependency outputs.** This task may depend on work done in earlier waves. Inspect the main branch of upstream repos (e.g., `wxyc-etl`) to understand available APIs, exported types, and module structure. If an upstream PR has not merged yet, check for its worktree branch under `/Users/jake/Developer/WXYC/<repo>/.claude/worktrees/` or `/Users/jake/Developer/claude-orchestrator/wxyc/worktrees/`.
4. **For Rust repos:** run `cargo check` before starting to confirm the baseline compiles.
5. **For Python repos:** run `pytest --co -q` (collect-only) to confirm the test suite loads.

## Development process

Follow test-driven development:

1. **Write a failing test** that captures the acceptance criteria.
2. **Implement** the minimum code to pass the test.
3. **Refactor** if needed, ensuring tests still pass.
4. **Repeat** until the full specification is implemented.

## Test commands

- **Rust repos** (`wxyc-etl`, `discogs-xml-converter`, `wikidata-json-filter`): `cargo test`
- **Python repos** (`discogs-cache`, `semantic-index`, `musicbrainz-cache`, `library-metadata-lookup`, `wxyc-catalog`): `pytest`

Run the appropriate test command and confirm all tests pass before proceeding to commit.

## Commit and PR

1. Stage and commit your changes with a clear, descriptive commit message. Do not mention AI or Claude anywhere.
2. Push the branch to origin.
3. Create a pull request with `gh pr create`. Include `Closes #{{ISSUE_NUMBER}}` in the PR body so the issue auto-closes on merge. Do not mention AI or Claude in the PR title or body.
4. Ensure any CI checks pass.

## Important rules

- Do not modify files outside your worktree.
- Do not modify shared scaffolding files (like `Cargo.toml` root workspace or `src/lib.rs` `pub mod` declarations) unless the issue explicitly requires it. Those are set up by the scaffolding step.
- When adding a new module to `wxyc-etl`, implement only within your module directory. The `pub mod` declaration in `src/lib.rs` already exists.
- For Python consumers using `wxyc-etl-python`, the PyO3 bindings expose the Rust functions. Check the bindings module for the available Python API.
- Respect existing patterns in each repo. Read nearby code before writing new code.
