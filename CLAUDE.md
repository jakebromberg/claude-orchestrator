## @funlandresearch/claude-orchestrator

TypeScript engine for launching parallel headless Claude sessions against
GitHub issues. Published as an npm package for reuse across projects.

### Structure

```
src/
├── types.ts              # All types and interfaces
├── engine.ts             # Orchestrator class, cleanUpMergedIssues
├── schema.ts             # Zod validation + validateConfig()
├── dag.ts                # Topological sort: computeWaves()
├── cli.ts                # Argument parsing (pure function)
├── status.ts             # Status/metadata stores (file-backed + in-memory)
├── process-pool.ts       # Parallel process management
├── stall-monitor.ts      # Log file growth monitor
├── log.ts                # Colored console logging
├── summary.ts            # Data-driven summary table renderer
├── watch.ts              # Live terminal dashboard
├── pr-tracker.ts         # PR URL extraction from logs
├── merge.ts              # PR merge with rebase
├── run-history.ts        # Run record persistence
├── dependency-files.ts   # Dependency file detection
├── report.ts             # Post-run report generation
├── real-process-runner.ts # Real child_process spawner
├── create-main.ts        # Generic entry point factory (sync or async ConfigFactory)
├── interpolate.ts        # {{var}} template substitution
├── yaml-types.ts         # YamlConfig, HooksOverride types
├── yaml-schema.ts        # Zod schema for YAML config validation
├── yaml-hooks.ts         # deriveHooks() — YAML fields → OrchestratorHooks
├── yaml-loader.ts        # loadYamlConfig() — full YAML→config pipeline
├── github.ts             # GitHub CLI wrapper (labels, comments)
├── upstream-context.ts   # HANDOFF.md reading for agent-to-agent context
├── issue-comments.ts     # Post run summary comments on GitHub issues
├── label-sync.ts         # GitHub label sync on status changes
├── decompose.ts          # LLM-driven task decomposition
├── decompose-types.ts    # Decompose input/output types
├── dashboard.ts          # HTTP dashboard server with SSE
├── dashboard-types.ts    # Dashboard dependency/option types
├── dashboard-html.ts     # Self-contained HTML template
├── index.ts              # Public API barrel export
└── testing.ts            # Test utility exports
```

### Key Patterns

- **Dependency injection**: `Deps` interface for all external interactions
- **In-memory testing**: All behavioral tests use `InMemoryStatusStore`,
  `InMemoryMetadataStore`, `createSilentLogger`, and mock `ProcessRunner`
- **Wave scheduling**: `computeWaves()` topological sort from `dependsOn`
- **Config validation**: Zod schema in `validateConfig()` with cycle detection
- **YAML configs**: Alternative to pure-TS configs — `loadYamlConfig()` reads
  a YAML file, validates it, derives convention-based hooks, and merges
  optional `.hooks.ts` overrides. `setUpWorktree`/`removeWorktree` must be
  provided via overrides (no universal default).
- **Status change hooks**: `onStatusChange` hook in `OrchestratorHooks` is called on every status transition via `setStatus()`. Used by label sync. Errors are non-fatal.
- **CI retry**: When `retryOnCheckFailure` is configured, failed `postSessionCheck` results trigger automatic re-runs with failure context injected into the prompt.
- **Hook event auditing**: `--include-hook-events` is passed by default so PreToolUse/PostToolUse hook decisions appear in the stream-json log for post-session analysis.

### YAML Config Fields

```yaml
name: "project-name"
configDir: ".orchestrator/config"
worktreeDir: ".worktrees"
projectRoot: "."
stallTimeout: 600
promptTemplate: "prompt.md"
branchPrefix: "orchestrator/"

# Post-session validation commands
postSessionCheck:
  commands: ["npm test", "npm run typecheck"]
  cwd: "."  # optional, relative to worktree

# Auto-retry on check failure
retryOnCheckFailure:
  maxRetries: 2
  enabled: true  # defaults to true if omitted

# Post run summary comments on GitHub issues
issueComments:
  repo: "owner/repo"
  enabled: true  # defaults to true if omitted

# Sync status labels on GitHub issues
labelSync:
  prefix: "orchestrator"
  repo: "owner/repo"  # optional, falls back to issue-level repo

# Template variables: {{ISSUE_NUMBER}}, {{SLUG}}, {{DESCRIPTION}},
# {{projectRoot}}, {{configDir}}, {{worktreeDir}}, {{UPSTREAM_CONTEXT}}

issues:
  - number: 1
    slug: feature-name
    dependsOn: []
    description: "Feature description"
```

### CLI Modes

```bash
<script> <config> [options]
  --help, -h         Show help
  --status           Show current issue statuses
  --watch            Live terminal dashboard
  --dashboard        Web dashboard (HTTP + SSE)
  --port <n>         Port for web dashboard (default: 3000)
  --merge            Merge succeeded PRs
  --cleanup          Remove worktrees and branches
  --retry-failed     Retry failed issues
  --tail             Reattach to detached run
  --decompose        LLM-driven task decomposition
  --file <path>      Input file for decompose
  --issue <n>        GitHub issue number for decompose
  --repo <owner/repo>  Repository for decompose/issue creation
  --create-issues    Create GitHub issues from decompose output
  --wave <n>         Run specific wave
  --parallel <n>     Max parallel sessions (default: 4)
  --merge-after-wave Merge PRs after each wave
  --detach           Run in background
  --notify           macOS notification on completion
```

### Commands

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```
