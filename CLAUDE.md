## @funlandresearch/claude-orchestrator

TypeScript engine for launching parallel headless Claude sessions against
GitHub issues. Published as an npm package for reuse across projects.

### Structure

```
src/
├── types.ts              # All types and interfaces
├── engine.ts             # Orchestrator class, cleanUpMergedIssues
├── schema.ts             # Zod validation + validateConfig()
├── dag.ts                # Wave assignment: computeWaves() — wraps topo.ts, adds ownsFiles/serial splitting
├── topo.ts               # Shared topological-sort core: readySet / layeredTopoSort (ship-dag's planner adopts it in C2b)
├── ref.ts                # Composite issue identity: refOf / normalizeDep / encode/decode / compareRef / compareRefString
├── cli.ts                # Argument parsing (pure function)
├── status.ts             # Status/metadata stores (file-backed + in-memory)
├── process-pool.ts       # Parallel process management
├── stall-monitor.ts      # Log file growth monitor
├── log.ts                # Colored console logging
├── summary.ts            # Data-driven summary table renderer
├── watch.ts              # Live terminal dashboard
├── pr-tracker.ts         # PR URL extraction from logs
├── merge.ts              # PR merge with rebase onto each PR's per-repo base branch
├── run-history.ts        # Run record persistence
├── dependency-files.ts   # Dependency file detection
├── report.ts             # Post-run report generation
├── memory-pressure.ts    # Memory-pressure level reader, heavy/session capacity tables, stop rule, cached sampler
├── capacity-governor.ts  # createCapacityGovernor() — pressure readings → launch capacity (bounds pipelines), 60 s hysteresis, transition logging
├── lease.ts              # Machine-wide heavy-command lease: holder files, 30 s mtime heartbeat (90 s staleness) + child-PID liveness, admission, fail-open (acquireLease, leaseStatus)
├── lease-events.ts       # leaseEventSink(): JSONL sink for the lease's onEvent seam — <lease dir>/events.jsonl, 5 MB rotation to events.jsonl.1, write failures swallowed
├── cli-lease.ts          # claude-orchestrator-lease bin: run a command under the lease (exit 75 no slot, 78 misconfigured), `status` as JSON
├── file-lock.ts          # tryLockOnce(): non-blocking O_EXCL mutex with mtime staleness (isWithinWindow is the shared freshness rule), token-checked release, turn-taking reapers (the lease's mutex)
├── claude-env.ts         # claudeSessionEnv() — child env for spawned `claude` sessions (auth/billing)
├── real-process-runner.ts # Real child_process spawner
├── create-main.ts        # Generic entry point factory (sync or async ConfigFactory)
├── interpolate.ts        # {{var}} template substitution
├── yaml-types.ts         # YamlConfig, HooksOverride types
├── yaml-schema.ts        # Zod schema for YAML config validation
├── yaml-hooks.ts         # deriveHooks() — YAML fields → OrchestratorHooks
├── yaml-loader.ts        # loadYamlConfig() — full YAML→config pipeline
├── worktree-hooks.ts     # deriveWorktreeHooks() — reusable per-repo checkout/worktree hooks
├── repo-settings.ts      # resolveRepoSettings() — per-repo baseBranch/CI/collision overrides (repos: map)
├── model-effort.ts       # resolveModelEffort() / perIssueSpawnArgs() — per-issue model/effort policy
├── mode-node.ts          # isModeNode/isCommandNode/isManualGate/cutoverReason — non-Claude nodes + cross-repo cutover gate
├── github.ts             # GitHub CLI wrapper (labels, comments)
├── upstream-context.ts   # HANDOFF.md reading for agent-to-agent context
├── issue-comments.ts     # Post run summary comments on GitHub issues
├── label-sync.ts         # GitHub label sync on status changes
├── decompose.ts          # LLM-driven task decomposition
├── decompose-types.ts    # Decompose input/output types
├── collision-check.ts    # Sequentially-numbered-file collision detection
├── counter-store.ts      # Per-domain counter store (in-memory + file-backed)
├── seed-from-git.ts      # Initial counter seed from origin/<baseBranch>
├── cli-claim.ts          # CLI helper for agents to claim a sequential number
├── dashboard.ts          # HTTP dashboard server with SSE
├── dashboard-types.ts    # Dashboard dependency/option types
├── dashboard-html.ts     # Self-contained HTML template
├── merge-appendable.ts   # Pure merge logic for append-only JSON array files
├── cli-merge-appendable.ts # claude-orchestrator-merge-appendable CLI (git driver + manual resolve)
├── index.ts              # Public API barrel export
└── testing.ts            # Test utility exports (in-memory stores, silent logger, scriptedPressureSampler)
```

### Key Patterns

- **Lease test fixtures**: `scriptedPressureSampler` (`src/testing.ts`) is the only way tests build a `PressureSampler`; `__tests__/helpers/lease.ts` (not a suite — vitest runs `*.test.ts` only) holds `isolatedLeaseEnv` (the integration suites' scrub of `CO_LEASE_*`/`CO_PRESSURE_*`, the guarantee that no test touches the real lease directory), `unwritableLeaseDir(tmp)` (a lease dir whose `mkdir` fails with ENOTDIR, to force an I/O error), and `fakeLeaseClock` (starts at real `Date.now()`, and its `sleep` yields via `setImmediate` so a runaway acquire loop fails by timeout instead of hanging).
- **Dependency injection**: `Deps` interface for all external interactions
- **In-memory testing**: All behavioral tests use `InMemoryStatusStore`,
  `InMemoryMetadataStore`, `createSilentLogger`, and mock `ProcessRunner`
- **Wave scheduling**: `computeWaves()` layers `dependsOn` into waves, with same-file ownership detection via `ownsFiles` (issues in the same candidate wave that claim overlapping non-shared files are slid to later waves by ascending issue number). The topological sort itself lives in `topo.ts` (`layeredTopoSort` / `readySet`) — a single composite-keyed core that ship-dag's `plan-waves.mjs` imports in C2b, so the engine's planner and the skill's planner won't drift. `computeWaves` throws on any unplaced node (a cycle, or an out-of-scope dep); ship-dag wraps the same core to report `{waves, blocked, cyclic}` gracefully against a `done` frontier.
- **Session auth/billing**: The engine drives the `claude` CLI, never the Anthropic API — but the CLI reads credentials from the environment before falling back to the Claude Code login, so an exported `ANTHROPIC_API_KEY` would silently bill every session as API credits (visible as `"apiKeySource":"ANTHROPIC_API_KEY"` in a session's stream-json `init` event). `claudeSessionEnv()` (`claude-env.ts`) builds the child env for every `claude` launch: it strips `CLAUDE*` (nested-session detection, **except** `CLAUDE_CODE_OAUTH_TOKEN`, which is the headless/CI subscription credential) plus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (billing), leaving other `ANTHROPIC_*` routing/config vars alone. Applied at all three launch sites — `real-process-runner.ts` (sessions), `create-main.ts` (`--decompose`), and `yaml-hooks.ts` (`onMergeConflict`); the two exec-based sites share `claudeExecOptions()` so neither can drop the env independently. Deliberately **not** applied to the `postSessionCheck` runner, which runs the project's own commands and may need those credentials — note the asymmetry, since the agent's own in-session Bash tool *does* get the scrubbed env. `claudeSessionEnv()` also strips `CO_LEASE_HOLDER`, so a session never inherits a lease holder id from the engine's environment (the engine itself ignores an inherited one: it acquires with `inheritedHolderId: undefined`, and the holder id reaches only the check's command child envs). `authBanner()` prints the resolved mode at run start and names any credential it dropped; it never claims a login it hasn't verified. Opt back in with `CLAUDE_ORCHESTRATOR_USE_API_KEY=1` (allowlist parse: `1`/`true`/`yes`/`on`, so typos fail closed) or `createRealProcessRunner({ useApiKey: true })`. `--detach` intentionally keeps its own narrow strip in `create-main.ts` — the child there is another orchestrator, which must inherit the opt-in var.
- **Memory-pressure adaptation**: `Deps.memoryPressure` (a `PressureSampler`; absent = `"unknown"`, today's behavior; only `createRealDeps` sets it, from `defaultPressureSampler()`, and only for the modes that launch sessions — `run-all`, `run-specific`, `retry-failed` — so a relative `CO_LEASE_DIR` fails a run at startup but never `--status` or another read-only mode) drives `launchAndWait`. One run-scoped `createCapacityGovernor` (so the 60 s hysteresis spans wave boundaries) ticks every 10 s from a per-`launchAndWait` timer, cleared when it returns. The timer is unref'd except while a launch waits in `waitForSlot`: with nothing running it is the launcher's only waker, and an unref'd tick let Node exit mid-wave with no report. `ProcessPool` limits slots to `min(maxParallel, capacity())`, so the 0-byte fallback's `setMaxParallel(1)` survives a return to `normal`; `recheck()` wakes every waiter and `waitForSlot()` re-checks in a loop, resolving `"go"` or `"stop"`. `"stop"` = `stopAtCritical(level, activeCount)` confirmed by `sampler.fresh()`, so one stale sample cannot end a wave. Unstarted issues stay `pending` with `failureReason: "memory-critical"`, `stopStage: "launch"`; both retry paths refuse to spawn when `fresh()` reads `critical` (issue `failed`, `stopStage: "retry"`), and a `PostCheckResult.stopped`, from the first check or a re-check after a retry, is never retried (`stopStage: "post-check"`). The marker is cleared (`NO_STOP`) when `prepareIssues` takes an issue up (every issue not skipped as already `succeeded`, so a skip, worktree failure or cutover hold never inherits it) and again on launch/retry/check, and `reportHeldGates` ignores marked rows. `--no-adaptive` (`RunOptions.adaptive: false`) drops `warning` adaptation and hysteresis only; capacity is still 0 at `critical`. The user's override is `CO_PRESSURE_OVERRIDE=critical-as-warning`, applied inside the sampler. **Known gaps**: `onMergeConflict`'s synchronous `claude -p` (under `after-wave` merging) and mode-node commands still start at `critical`; neither runs in ship-dag's engine use.
- **Post-session check lease**: `Deps.lease` (`LeaseOptions`; set only by `createRealDeps` for the dispatch modes, from the same `defaultLeaseOptions(process.env, { warn: consoleLogger.warn })` call that supplies `memoryPressure`, so `deps.lease.level === deps.memoryPressure`; absent means unleased, no lease I/O) reaches `OrchestratorHooks.postSessionCheck` as `ctx: { lease, runningSessions }`. The derived check (`yaml-hooks.ts`) acquires one slot before its command loop (label `post-check <ref>`), passes `handle.childEnv()` and `handle.setChildPid` through `runCommand(cmd, cwd, env, onSpawn)`, and releases in `finally`. It waits with no time cap, logging at most once a minute (throttled on `performance.now()`), and applies the stop rule through `stopWhen: stopAtCritical(level, live + runningSessions())`; a confirmed stop skips the commands but still runs the collision scan, and returns `stopped: "memory-critical"` (never retried). `runningSessions` is the engine's own `liveSessions` counter, incremented and decremented only in `spawnSession` (the exit reaction runs first, on both resolve and reject), never the pool's `activeCount`, which includes the waiting check's own slot.
- **Clocks**: in-process durations (e.g. the capacity governor's 60 s hysteresis) use monotonic time (`performance.now()`). Timestamps other processes read use wall-clock time, with the freshness rule chosen per timestamp: `level.json`'s `at` uses `isFresh` (a reading from the future is not fresh, and a reading that is not fresh falls back to `critical`, which can only stop work), while the mutex and holder heartbeat mtimes and holder `startedAt` use the symmetric `isWithinWindow` / `Math.abs` rule (a small step either way must not reap a live holder). Known exceptions, in-process timers still on the wall clock — don't copy them: the lease's wait timers (`waitedMs`, the 30 s busy fail-open, `maxWaitMs`, on `LeaseOptions.now`), the lease CLI's progress throttle, the counter store's lock spin timeout, and the sampler's `cachedPressureSampler` TTL and in-process last-good fallback age (both guarded by `isFresh`, which treats a reading dated in the future as expired, so the cache re-reads and the fallback reads `critical`; a backward step smaller than a reading's age still stretches its life by the size of the step, at most one window). Reported durations (a release event's `heldMs`, a run record's `durationSeconds`) are differences of wall-clock timestamps and stay on the wall clock on purpose.
- **Config validation**: Zod schema in `validateConfig()` with cycle detection
- **YAML configs**: Alternative to pure-TS configs — `loadYamlConfig()` reads
  a YAML file, validates it, derives convention-based hooks, and merges
  optional `.hooks.ts` overrides. `setUpWorktree`/`removeWorktree` must be
  provided via overrides (no universal default).
- **Status change hooks**: `onStatusChange` hook in `OrchestratorHooks` is called on every status transition via `setStatus()`. Used by label sync. Errors are non-fatal.
- **CI retry**: When `retryOnCheckFailure` is configured, failed `postSessionCheck` results trigger automatic re-runs with failure context injected into the prompt.
- **Hook event auditing**: `--include-hook-events` is passed by default so PreToolUse/PostToolUse hook decisions appear in the stream-json log for post-session analysis.
- **Sequential-file collision detection**: When `sequentialPaths` is configured, `postSessionCheck` scans peer worktrees and `origin/<baseBranch>` for files added with the same captured key (e.g. Drizzle migration `NNNN_*.sql`) and fails the session on overlap. Failure context names the colliding peer/file and a suggested next-safe number, suitable for `retryOnCheckFailure` injection.
- **Journal-aware merge driver**: When `appendableFiles` is configured, the `claude-orchestrator-merge-appendable` CLI can be wired as a git merge driver via `.gitattributes`. It merges append-only JSON arrays by a `keyField` (e.g. Drizzle `_journal.json` by `idx`), eliminating manual conflict resolution after parallel migrations. Supports git driver mode (`--base %O --current %A --incoming %B`) and manual post-conflict mode (`--resolve <file>`).
- **Sequential-number coordination (`claimSequentialNumber`)**: When `sequentialDomains` is configured, the orchestrator exposes a `{{CLAIM_NUMBER}}` prompt variable that resolves to a partial CLI command (`node cli-claim.js --config <yaml> --issue <n> --domain`). Agents append a domain name and invoke the helper to receive a guaranteed-unique zero-padded number. State persists to `<configDir>/counters/<domain>.json` with a lockfile for cross-process safety. Claims are idempotent per `(domain, issueNumber)` so retries reuse the same number. First claim per domain seeds from `origin/<baseBranch>`. Composes with `sequentialPaths` (claim is primary synchronization, detection is the backstop).

### YAML Config Fields

```yaml
name: "project-name"
configDir: ".orchestrator/config"
worktreeDir: ".worktrees"
projectRoot: "."
stallTimeout: 600
promptTemplate: "prompt.md"
branchPrefix: "orchestrator/"

# Repo assigned to issues that don't declare their own `repo`, used to build each
# issue's composite ref ("owner/repo#N"). When unset, repo-less issues key on
# their bare number "N" (single-repo back-compat; on-disk state filenames and
# numeric ordering are unchanged).
defaultRepo: "owner/repo"

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

# Base branch used for collision-detection diffs and counter seeding (default "main")
baseBranch: "main"

# Default model/effort for the per-issue policy (model-effort.ts). Baseline is
# Sonnet; effort defaults to medium (or the per-issue complexity tier). Retries
# escalate effort one tier per attempt (cap max); Haiku at high+ effort is
# promoted to Sonnet. Per-issue model/effort/complexity override these.
defaultModel: "sonnet"
defaultEffort: "medium"

# Per-repo overrides for cross-repo DAGs, keyed by owner/repo. Each entry may
# override baseBranch, postSessionCheck, sequentialPaths, appendableFiles for
# issues that declare (or inherit via defaultRepo) that repo. Replace semantics,
# not deep-merge; an omitted field inherits the top-level value. A key not
# referenced by any issue/defaultRepo is a hard load error (typo guard).
repos:
  "WXYC/wxyc-ios-64":
    baseBranch: "master"                       # iOS forks from master, not main
    postSessionCheck:
      commands: ["xcodebuild test -scheme WXYC"]
  "WXYC/library-metadata-lookup":
    postSessionCheck:
      commands: ["ruff check .", "pytest -q"]

# Detect sequentially-numbered-file collisions across peer worktrees during postSessionCheck
sequentialPaths:
  - dir: "shared/database/src/migrations"
    pattern: "(\\d{4})_.*\\.sql"  # group 1 is the unique key

# Coordination domains for guaranteed-unique numbering (issue #25). When set,
# {{CLAIM_NUMBER}} is exposed as a prompt template variable.
sequentialDomains:
  migrations:
    paths:
      - dir: "shared/database/src/migrations"
        pattern: "(\\d{4})_.*\\.sql"
    width: 4

# Append-style JSON array files wired to the journal-aware merge driver (issue #37).
# Prevents merge conflicts on files like Drizzle's _journal.json.
appendableFiles:
  - path: "shared/database/src/migrations/meta/_journal.json"
    format: "json-array"
    arrayPath: "entries"
    keyField: "idx"

# Files safe to overlap across parallel issues (ownsFiles allowlist).
# appendableFiles paths are automatically exempt; list others here.
sharedFiles:
  - "package-lock.json"
  - "tests/mocks/database.mock.ts"

# Template variables: {{ISSUE_NUMBER}}, {{SLUG}}, {{DESCRIPTION}},
# {{projectRoot}}, {{configDir}}, {{worktreeDir}}, {{UPSTREAM_CONTEXT}},
# {{CLAIM_NUMBER}} (only when sequentialDomains is configured)

issues:
  - number: 1
    slug: feature-name
    dependsOn: []
    # repo: "owner/repo"  # optional; overrides defaultRepo for this issue's ref
    description: "Feature description"
    # model: opus         # optional; alias (haiku/sonnet/opus) or full id; overrides defaultModel
    # effort: high        # optional; low|medium|high|xhigh|max; overrides the complexity tier
    # complexity: complex # optional; mechanical→low, normal→medium, complex→high (sets default effort)
    # extraDirs: ["../wxyc-shared"]  # optional; extra read-only dirs (--add-dir); relative to config file
    # serial: true  # optional; runs this issue alone in its own wave (e.g. for migrations)
    # ownsFiles:    # optional; files this issue expects to write (triggers wave serialization on overlap)
  # dependsOn entries are a bare number/numeric-string (same repo as this issue)
  # or a fully-qualified cross-repo ref "owner/repo#N":
  #   dependsOn: [1, "WXYC/other-repo#2"]
  # A mode-node (mode-node.ts) runs a command instead of a Claude session — no
  # worktree/model/effort. mode is deploy|publish|gate. With a command it runs it
  # (exit 0 → succeeded, non-zero → failed); WITHOUT a command it's a manual gate
  # that holds for a confirmCutover hook. Skipped by the merge step (no PR).
  # - number: 2
  #   slug: deploy-lml
  #   mode: deploy
  #   command: "gh workflow run deploy.yml -R WXYC/library-metadata-lookup"
  #   dependsOn: [1]
```

A **cutover gate** stops the engine before releasing an issue behind a command-less manual gate or a bare cross-repo dependency (a dep in another repo that isn't itself a mode-node — a command node's exit-0 or a manual gate's own confirmation already counts as the cutover). Confirmation comes from an optional `confirmCutover(issue, reason)` hook; when it's absent, gated issues **hold** (left `pending`, dependents skip) — a cross-repo run wires `confirmCutover` or uses command mode-nodes to progress unattended. See `cutoverReason` in `mode-node.ts`.

### Wave-plan preview (`--plan`)

Before committing compute to a cross-repo run, `--plan` prints — read-only, no worktrees, no dispatch — the exact wave partition the engine would execute: each issue grouped under its wave by composite ref (so colliding numbers across repos stay distinct), its resolved model/effort or mode-node kind + command, its dependencies, and a trailing list of the HITL cutover gates where the run will hold. It's the acceptance check for a new config: confirm the waves and gates read correctly before you run it for real. Rendered by the pure `renderPlanPreview(config)` (`plan-preview.ts`). The model/effort shown is the per-issue + config-default policy; it does not reflect a config that pins the model via generic `claudeArgs`/`getClaudeArgs` (which the engine applies last).

### CLI Modes

```bash
<script> <config> [options]
  --help, -h         Show help
  --status           Show current issue statuses
  --plan             Preview the wave partition without running (read-only)
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
  --no-adaptive      Skip warning adaptation and the 60 s hysteresis (critical still stops launches and retries)
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

### Self-hosted orchestration

This repo orchestrates work on its own open issues via `.orchestrator/`. See `.orchestrator/README.md` for the per-wave workflow.

```bash
npm run orchestrate           # Run a wave (configure issues in .orchestrator/config.yaml first)
npm run orchestrate:status    # Show current issue statuses
npm run orchestrate:dashboard # HTTP dashboard at :3000
npm run orchestrate:cleanup   # Remove worktrees and branches
```

`.orchestrator/run.ts` imports the orchestrator core from `dist/`, so `npm run build` must be up-to-date before running.
