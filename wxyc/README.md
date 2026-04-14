# WXYC ETL Pipeline Unification Orchestrator

Orchestrator configuration for the WXYC ETL Pipeline Unification project -- 26 tasks (1 scaffolding + 25 implementation) across 9 repos, scheduled in dependency-aware waves.

## Prerequisites

- Node.js 20+
- `cargo` (Rust toolchain)
- `gh` (GitHub CLI, authenticated)
- `python3` + `pytest` (for Python repos)
- All target repos cloned under `/Users/jake/Developer/WXYC/`

## Directory structure

```
wxyc/
  orchestrator.yaml   # Issue definitions, dependencies, and YAML config
  orchestrate.ts      # TypeScript entry point with multi-repo worktree hooks
  prompt.md           # Prompt template for Claude sessions
  README.md           # This file
  state/              # Created at runtime -- status and metadata stores
  worktrees/          # Created at runtime -- git worktrees per issue
```

## Usage

All commands are run from the `wxyc/` directory.

```bash
# Install dependencies (one time)
npm install @funlandresearch/claude-orchestrator tsx

# Run all waves
npx tsx orchestrate.ts etl

# Run with higher parallelism
npx tsx orchestrate.ts etl --parallel 8

# Run a single wave
npx tsx orchestrate.ts etl --wave 1

# Run specific issues by orchestrator number
npx tsx orchestrate.ts etl 1 2 3

# Check status
npx tsx orchestrate.ts etl --status

# Retry failed issues
npx tsx orchestrate.ts etl --retry-failed

# Live dashboard
npx tsx orchestrate.ts etl --watch

# Run in background
npx tsx orchestrate.ts etl --detach
npx tsx orchestrate.ts etl --tail

# Merge succeeded PRs
npx tsx orchestrate.ts etl --merge

# Clean up worktrees and logs
npx tsx orchestrate.ts etl --cleanup
```

## Issue numbering

The orchestrator uses sequential numbers 0-25. Issue 0 is a synthetic scaffolding step. Issues 1-25 map to GitHub issues across repos:

| # | Phase | Repo | GH Issue | Task |
|---|-------|------|----------|------|
| 0 | 0 | wxyc-etl | -- | Scaffold repo skeleton |
| 1 | 1 | wxyc-etl | #1 | text/ module |
| 2 | 1 | wxyc-etl | #2 | pg/ module |
| 3 | 1 | wxyc-etl | #3 | pipeline/ module |
| 4 | 1 | wxyc-etl | #4 | csv/, sqlite/, state/, import/, schema/ modules |
| 5 | 1 | wxyc-etl | #5 | fuzzy/ module |
| 6 | 1 | wxyc-etl | #6 | parser/mysql |
| 7 | 1 | wxyc-etl | #7 | PyO3 bindings |
| 8 | 2 | discogs-cache | #63 | batch_classify_releases() |
| 9 | 2 | semantic-index | #112 | batch_fuzzy_resolve() |
| 10 | 2 | musicbrainz-cache | #1 | batch_filter_artists() |
| 11 | 2 | discogs-cache | #64 | Rust DedupSet |
| 12 | 2 | semantic-index | #113 | sql_parser_rs migration |
| 13 | 3 | discogs-xml-converter | #21 | Depend on wxyc-etl |
| 14 | 3 | wikidata-json-filter | #1 | Depend on wxyc-etl |
| 15 | 3 | wxyc-catalog | #1 | Create package |
| 16 | 3 | wxyc-catalog | #2 | Source transports |
| 17 | 4 | discogs-cache | #65 | Slim down |
| 18 | 4 | library-metadata-lookup | #95 | Complete LML migration |
| 19 | 4 | semantic-index | #114 | Complete migration |
| 20 | 5 | library-metadata-lookup | #96 | Entity store schema |
| 21 | 5 | library-metadata-lookup | #97 | Streaming availability |
| 22 | 5 | library-metadata-lookup | #98 | Identity REST endpoints |
| 23 | 5 | semantic-index | #115 | Cleanup dead code |
| 24 | 6 | musicbrainz-cache | #2 | Convert to Rust |
| 25 | 6 | wikidata-json-filter | #2 | wikidata-cache CSV to PG |

## Wave scheduling

The orchestrator computes waves automatically from `dependsOn` declarations. The approximate wave structure is:

- **Wave 1**: Issue 0 (scaffolding)
- **Wave 2**: Issues 1, 2, 3, 4, 6 (independent wxyc-etl modules)
- **Wave 3**: Issue 5 (fuzzy, depends on text)
- **Wave 4**: Issue 7 (PyO3 bindings, depends on most wxyc-etl modules)
- **Wave 5**: Issues 8-16 (Python/Rust consumers + wxyc-catalog)
- **Wave 6**: Issues 17-20 (slim down + entity store)
- **Wave 7**: Issues 18, 19, 21, 22 (migrations + entity store consumers)
- **Wave 8**: Issue 23 (cleanup, depends on 21+22)
- **Wave 9**: Issues 24, 25 (full Rust conversions, independent of later phases)

Note: Issues 13, 14, 24, 25 can run earlier than their listed phase because their dependencies resolve in earlier waves. The orchestrator handles this automatically.

## Multi-repo worktree management

Each issue creates a git worktree in the correct repo under `wxyc/worktrees/<slug>`. The `orchestrate.ts` hooks handle:

- Mapping orchestrator issue numbers to repo + GitHub issue number
- Creating worktrees from the correct repo's default branch
- Installing language-specific dependencies (npm, pip/uv, cargo)
- Running post-session test checks (`cargo test` or `pytest`)
- Providing cross-repo visibility via `--add-dir` for `wxyc-etl` and `wxyc-catalog`
- Bootstrapping new repos (`wxyc-etl`, `wxyc-catalog`) that don't exist yet

## Scaffolding step

Issue 0 is a synthetic step that creates the `wxyc-etl` repo skeleton before any Phase 1 modules run. It creates `Cargo.toml`, `src/lib.rs` with all `pub mod` declarations, and empty module directories. This prevents parallel Phase 1 tasks from conflicting on shared files.
