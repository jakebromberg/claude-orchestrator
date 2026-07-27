# @funlandresearch/claude-orchestrator

TypeScript engine for launching parallel headless Claude sessions against
GitHub issues. Each session runs in an isolated git worktree, with wave-based
scheduling driven by issue dependencies.

## Install

```bash
npm install @funlandresearch/claude-orchestrator

# Or install directly from GitHub:
npm install github:jakebromberg/claude-orchestrator
```

## Quick Start

### 1. Create a YAML config

```yaml
# orchestrator.yaml
name: "My Orchestrator"
configDir: "./my-orchestrator"
worktreeDir: "./worktrees"
projectRoot: "."
stallTimeout: 300
allowedTools: [Bash, Read, Write, Edit]

branchPrefix: "feature/"
retryableStatuses: [failed, interrupted]
promptTemplate: "./prompt.md"       # supports {{ISSUE_NUMBER}}, {{SLUG}}, {{DESCRIPTION}}, {{projectRoot}}
claudeArgs:
  - "--add-dir"
  - "{{projectRoot}}"

postSessionCheck:
  commands: ["npm test", "npx tsc --noEmit"]
  cwd: "scripts"                    # relative to worktree root

summary:
  title: "Status"
  columns:
    - { header: "Issue", width: 6, value: "issue.number", prefix: "#" }
    - { header: "Description", width: 30, value: "issue.description" }
    - { header: "Wave", width: 6, value: "issue.wave" }
    - { header: "Status", width: 14, value: "status" }

issues:
  - { number: 1, slug: setup, dependsOn: [], description: "Initial setup" }
  - { number: 2, slug: api, dependsOn: [1], description: "Build API layer" }
  - { number: 3, slug: ui, dependsOn: [1], description: "Build UI components" }
  - { number: 4, slug: deploy, dependsOn: [2, 3], description: "Deploy to prod" }
```

Paths are resolved relative to the YAML file's directory. Most hooks are derived automatically from the YAML fields (branch naming, retry logic, summary table, prompt interpolation, etc.).

### 2. Wire it up

`setUpWorktree` and `removeWorktree` have no universal default and must be provided as hook overrides:

```typescript
// orchestrate.ts
import { createMain, loadYamlConfig } from "@funlandresearch/claude-orchestrator";
import type { HooksOverride } from "@funlandresearch/claude-orchestrator";

const hooksOverride: HooksOverride = {
  async setUpWorktree(issue) { /* create git worktree + install deps */ },
  async removeWorktree(issue) { /* remove git worktree */ },
};
```

#### Cross-repo checkouts: `deriveWorktreeHooks`

For a DAG that spans repos, wiring `setUpWorktree`/`removeWorktree` by hand is repetitive. `deriveWorktreeHooks` packages the common shape — locate each issue's checkout, fork a branch off that repo's own base branch, and place the worktree in the sibling `<repo>-worktrees/` directory:

```typescript
import { deriveWorktreeHooks } from "@funlandresearch/claude-orchestrator";
import type { HooksOverride } from "@funlandresearch/claude-orchestrator";

// Defaults: reposDir = ~/Developer/WXYC, branch = orchestrator/<slug>,
// base branch derived per-repo from `git rev-parse --abbrev-ref origin/HEAD`.
const hooksOverride: HooksOverride = { ...deriveWorktreeHooks() };
```

Each issue's `repo` (`owner/repo`, e.g. `WXYC/library-metadata-lookup`) resolves to the checkout `<reposDir>/library-metadata-lookup` — the owner is the parent directory. The base branch is **derived, never assumed**: a repo whose `origin/HEAD` points at `master` (such as `wxyc-ios-64`) forks from `origin/master`, while repos on `main` fork from `origin/main`. Forking from the `origin/` remote-tracking ref (rather than the local branch of the same name) starts each worktree from the freshest fetched state. Override any of `reposDir`, `repoOf`, `worktreeRoot`, `baseBranchOf`, or `getBranchName` to fit a different layout:

```typescript
const hooksOverride: HooksOverride = {
  ...deriveWorktreeHooks({
    reposDir: "/srv/checkouts",
    baseBranchOf: (repoDir) => (repoDir.endsWith("wxyc-ios-64") ? "origin/master" : "origin/main"),
  }),
};
```

`deriveWorktreeHooks` only lays out the worktree; it installs no dependencies. When a repo's `postSessionCheck` needs them (e.g. `npm test`), wrap `setUpWorktree` to install after the worktree exists:

```typescript
const wt = deriveWorktreeHooks();
const hooksOverride: HooksOverride = {
  ...wt,
  async setUpWorktree(issue) {
    await wt.setUpWorktree(issue);
    execFileSync("npm", ["ci"], { cwd: wt.getWorktreePath(issue), stdio: "pipe" });
  },
};
```

createMain({
  configs: {
    myconfig: (projectRoot) =>
      loadYamlConfig(`${projectRoot}/orchestrator.yaml`, { hooksOverride }),
  },
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

#### Per-repo settings: the `repos:` map

`deriveWorktreeHooks` places each repo's worktree correctly; the `repos:` map handles the other half — that each repo has its own base branch, CI profile, and collision domains. Keyed by `owner/repo`, every entry may override `baseBranch`, `postSessionCheck`, `sequentialPaths`, and `appendableFiles` for the issues that declare that `repo` (or inherit it from `defaultRepo`):

```yaml
defaultRepo: WXYC/Backend-Service
baseBranch: main                       # top-level default for every repo
postSessionCheck:
  commands: ["npm run ci:testmock"]    # default check profile
repos:
  WXYC/wxyc-ios-64:
    baseBranch: master                 # iOS forks from master, not main
    postSessionCheck:
      commands: ["xcodebuild test -scheme WXYC"]
  WXYC/library-metadata-lookup:
    postSessionCheck:
      commands: ["ruff check .", "pytest -q"]
issues:
  - { number: 924, slug: lml-perf, dependsOn: [], description: "...", repo: WXYC/library-metadata-lookup }
  - { number: 685, slug: ios-tab, dependsOn: [924], description: "...", repo: WXYC/wxyc-ios-64 }
```

Resolution is **replace, not deep-merge**: an entry that sets `postSessionCheck` uses only its own commands, and one that omits a field inherits the top-level value for it. The resolved `baseBranch` flows into that repo's collision diffs and counter seeding, so an iOS migration scan targets `origin/master` while a Backend-Service one targets `origin/main`; collision detection also considers only same-repo peers, since files in different repos can't collide. A `repos:` key that no issue references (nor `defaultRepo`) is a hard load error — an unused key is almost always a typo that would otherwise silently leave the real repo on the wrong base branch.

#### Per-issue model & effort

Each issue runs its own implement session, so each picks its own model and effort tier rather than sharing one model for the whole run. The default is **Sonnet**, with effort set by an optional `complexity` tag (`mechanical`→`low`, `normal`→`medium`, `complex`→`high`). Set `defaultModel`/`defaultEffort` at the top level to move the baseline, and override per issue with `model`, `effort`, or `complexity`:

```yaml
defaultModel: sonnet     # baseline model for every issue (default: sonnet)
defaultEffort: medium    # baseline effort when an issue sets neither effort nor complexity

issues:
  - { number: 1, slug: bump-dep, dependsOn: [], description: "Bump lodash", complexity: mechanical }   # sonnet / low
  - { number: 2, slug: api, dependsOn: [1], description: "New endpoint", complexity: normal }           # sonnet / medium
  - { number: 3, slug: migration, dependsOn: [1], description: "Schema change", complexity: complex }   # sonnet / high
  - { number: 4, slug: hairy, dependsOn: [1], description: "Concurrency rework", model: opus, effort: max }
  - number: 5
    slug: ios-feature
    dependsOn: [1]
    description: "iOS On Tour tab"
    repo: WXYC/wxyc-ios-64
    extraDirs: ["../wxyc-shared"]   # extra read-only dirs (`--add-dir`); relative paths resolve against the config file
```

Precedence for effort is explicit `effort` → `complexity` tier → `defaultEffort` → `medium`. A [CI-failure retry](#ci-failure-retry) bumps effort one tier per attempt (capped at `max`) while keeping the model. One guardrail applies: a Haiku-class model resolved to `high` effort or above is promoted to Sonnet instead — a weak model straining costs more per token than a stronger model deliberating less. `model` accepts an alias (`haiku`/`sonnet`/`opus`) or a full model id. A config's `claudeArgs`/`getClaudeArgs` output is appended after these, so it can still override the model via last-wins.

### 3. Run it

```bash
npx tsx orchestrate.ts myconfig              # Run all waves (up to 4 in parallel)
npx tsx orchestrate.ts myconfig --parallel 8 # Run up to 8 issues concurrently
npx tsx orchestrate.ts myconfig --status     # Show status table
npx tsx orchestrate.ts myconfig --wave 1     # Run wave 1 only
npx tsx orchestrate.ts myconfig 1 2 3        # Run specific issues
npx tsx orchestrate.ts myconfig --retry-failed
npx tsx orchestrate.ts myconfig --merge      # Merge succeeded PRs
npx tsx orchestrate.ts myconfig --watch      # Live dashboard
npx tsx orchestrate.ts myconfig --detach     # Run in background
npx tsx orchestrate.ts myconfig --tail       # Reattach to background run
npx tsx orchestrate.ts myconfig --cleanup    # Remove worktrees and logs
```

## Programmatic Configuration

For full control, you can skip the YAML file and build configs in TypeScript:

```typescript
// orchestrate.ts
import { createMain, validateConfig, createPrintSummary } from "@funlandresearch/claude-orchestrator";
import type { IssueSpec, OrchestratorConfig } from "@funlandresearch/claude-orchestrator";

const ISSUES: IssueSpec[] = [
  { number: 1, slug: "setup",  dependsOn: [],  description: "Initial setup" },
  { number: 2, slug: "build",  dependsOn: [1], description: "Build pipeline" },
  { number: 3, slug: "deploy", dependsOn: [2], description: "Deploy to prod" },
];

function createMyConfig(projectRoot: string): OrchestratorConfig {
  return validateConfig({
    name: "My Orchestrator",
    configDir: `${projectRoot}/my-orchestrator`,
    worktreeDir: `${projectRoot}/worktrees`,
    projectRoot,
    stallTimeout: 300,
    issues: ISSUES,
    hooks: {
      showHelp() { console.log("Usage: npx tsx orchestrate.ts myconfig [options]"); },
      shouldSkipIssue() { return { skip: false }; },
      isRetryableStatus(s) { return s === "failed" || s === "interrupted"; },
      async preflightCheck() {},
      async preRunSetup() {},
      async setUpWorktree(issue) { /* create git worktree */ },
      async removeWorktree(issue) { /* remove git worktree */ },
      getWorktreePath(issue) { return `${projectRoot}/worktrees/${issue.slug}`; },
      getBranchName(issue) { return `feature/${issue.slug}`; },
      async interpolatePrompt(issue) { return `Fix issue #${issue.number}: ${issue.description}`; },
      getClaudeArgs() { return []; },
      printSummary: createPrintSummary({
        title: "Status",
        columns: [
          { header: "Issue", width: 6, value: (i) => "#" + i.number },
          { header: "Description", width: 30, value: (i) => i.description },
          { header: "Status", width: 14, value: (_, s) => s },
        ],
      }),
    },
  });
}

createMain({
  configs: { myconfig: createMyConfig },
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

`ConfigFactory` accepts both sync and async return values, so `loadYamlConfig` (async) and `validateConfig` (sync) both work directly with `createMain`.

## Architecture

The engine uses dependency injection for all external interactions:

- **`StatusStore`** - Read/write issue statuses (file-backed or in-memory)
- **`MetadataStore`** - PR URLs, exit codes, timing, files changed
- **`ProcessRunner`** - Spawn Claude processes
- **`Logger`** - Console output
- **`OrchestratorHooks`** - Project-specific behavior (worktree setup, prompts, etc.)

All behavioral tests run in-memory without spawning real processes.

### Wave Scheduling

Issues declare dependencies via `dependsOn`. The engine computes waves using
topological sort: wave 1 has no dependencies, wave 2 depends on wave 1, etc.
Within a wave, issues run in parallel up to `--parallel N`.

#### Caveat: parallel issues that produce sequentially-numbered files

Two issues running in the same wave each see the same `origin/main` checkout. If both create a sequentially-numbered file by reading the highest existing number and adding one (Drizzle migrations `NNNN_*.sql`, Rails-style migrations, knex, append-only changelogs, etc.), they will independently pick the **same** number. The collision only surfaces at merge time, requiring manual renumbering of the second PR.

Workaround: mark issues that produce these artifacts as `serial: true` in YAML (or set `serial: true` on the `IssueSpec` programmatically). A serial issue runs alone in its own wave — no other issue runs in parallel with it. Within each base wave, all non-serial issues run together first, then each serial issue runs by itself in issue-number order. Issues in later base waves wait until all serials in earlier base waves finish.

```yaml
issues:
  - { number: 1, slug: schema-column,  dependsOn: [], description: "Add column X", serial: true }
  - { number: 2, slug: scheduled-job, dependsOn: [], description: "Add cron job", serial: true }
  - { number: 3, slug: ui-tweak,      dependsOn: [], description: "Tweak button" }             # runs in parallel with #4
  - { number: 4, slug: docs-update,   dependsOn: [], description: "Update README" }            # runs in parallel with #3
```

This is a brute-force serialization — an issue that only depends on a non-serial sibling will still wait until any serial siblings in the same base wave finish. Use it sparingly, only on issues that genuinely conflict on shared sequential state.

#### Detection: `sequentialPaths` collision check

For projects that don't want to give up parallelism but do want a safety net, configure `sequentialPaths` to detect collisions in `postSessionCheck`. After each session completes successfully (and any configured `commands` pass), the orchestrator scans the current branch's added files matching the pattern, then walks peer worktrees and `origin/<baseBranch>` for the same captured key. On a collision, the session is marked failed; if `retryOnCheckFailure` is enabled, the failure context — including the suggested next-safe number — is injected into the retry prompt.

```yaml
baseBranch: main           # optional, defaults to "main"; override per repo under `repos:`
sequentialPaths:
  - dir: shared/database/src/migrations
    pattern: "(\\d{4})_.*\\.sql"
```

`baseBranch`, `postSessionCheck`, `sequentialPaths`, and `appendableFiles` can all be overridden per repo via the [`repos:` map](#per-repo-settings-the-repos-map) — in a cross-repo DAG the scan targets each issue's repo base branch (iOS `origin/master`, others `origin/main`) and only same-repo peers.

The pattern must compile as a JavaScript regex and contain at least one capture group; group 1 is the unique key (typically a zero-padded number). Multiple `sequentialPaths` entries are independent number spaces.

This is **detection, not synchronization**. Two parallel issues finishing near-simultaneously can both fail the check; that's the documented limitation. Detection complements `serial: true` rather than replacing it: keep `serial: true` for high-collision-risk issues, and let detection catch the rest.

#### Coordination: `sequentialDomains` + `claim` CLI

For guaranteed-unique numbering — the synchronization that detection alone can't provide — configure `sequentialDomains` and instruct agents to claim a number from the orchestrator instead of computing one locally. The orchestrator hands out monotonically-increasing numbers per domain, persisted in `<configDir>/counters/<domain>.json`, with a per-domain lockfile so concurrent claims (across parallel sessions or the orchestrator's `--detach` background mode) are safe.

```yaml
baseBranch: main
sequentialDomains:
  migrations:
    paths:
      - dir: shared/database/src/migrations
        pattern: "(\\d{4})_.*\\.sql"
    width: 4   # zero-padding for the formatted output (e.g. "0057")
```

When `sequentialDomains` is set, the orchestrator exposes a `{{CLAIM_NUMBER}}` template variable that resolves to a partial command:

```
node /abs/path/to/dist/src/cli-claim.js --config <yaml> --issue <n> --domain
```

Your prompt template instructs the agent to invoke the helper with the desired domain appended, e.g.:

```text
Before writing a migration file, claim a number:

  num=$({{CLAIM_NUMBER}} migrations)

Then write the file as `shared/database/src/migrations/${num}_<slug>.sql`.
```

The helper prints just the formatted number (`0057`) to stdout. Claims are idempotent per `(domain, issueNumber)` so a retry of the same session reuses the same number rather than burning a new slot.

On the first claim for a domain the counter is seeded by scanning `origin/<baseBranch>` for the highest existing key, so `0001-0056` already on `main` correctly produces `0057` as the first hand-out. The seed runs once per domain; if migrations are merged out-of-band between orchestrator runs, delete the affected `<configDir>/counters/<domain>.json` to force a re-seed.

`sequentialDomains` and `sequentialPaths` are independent and complementary: claim is the primary synchronization, detection is the backstop in case an agent skips the claim step. Both can be configured together.

### Hook Interface

Each config provides an `OrchestratorHooks` object:

| Hook | Description |
|------|-------------|
| `showHelp()` | Print usage text |
| `shouldSkipIssue(issue)` | Return `{ skip, reason? }` to skip issues |
| `isRetryableStatus(status)` | Which statuses `--retry-failed` retries |
| `preflightCheck()` | Validate environment before running |
| `preRunSetup()` | One-time setup (e.g., cache issue bodies) |
| `setUpWorktree(issue)` | Create git worktree and install deps |
| `removeWorktree(issue)` | Remove git worktree |
| `getWorktreePath(issue)` | Return worktree directory path |
| `getBranchName(issue)` | Return branch name for the issue |
| `interpolatePrompt(issue)` | Build the Claude prompt |
| `getClaudeArgs(issue)` | Extra CLI args for claude |
| `printSummary(issues, getStatus)` | Display status table |
| `postSessionCheck?(issue, path)` | Optional post-session validation (returns `PostCheckResult` with `passed`, `summary`, `output`) |
| `onStatusChange?(issue, old, new)` | Optional hook called on every status transition (used by label sync) |

### Agent-to-Agent Communication

Upstream agents can write a `HANDOFF.md` file in their worktree root. When downstream issues start, the orchestrator reads `HANDOFF.md` from each dependency's worktree and injects the content into the prompt template via `{{UPSTREAM_CONTEXT}}`.

### GitHub Integration

- **Issue comments**: Set `issueComments: { repo: "owner/repo" }` in YAML to post run summary comments on GitHub issues after each run.
- **Label sync**: Set `labelSync: { prefix: "orchestrator" }` in YAML to sync status labels (e.g., `orchestrator:running`, `orchestrator:succeeded`) on GitHub issues as statuses change.

### CI Failure Retry

Set `retryOnCheckFailure: { maxRetries: 2 }` in YAML to automatically retry agent sessions when `postSessionCheck` fails. The failure output is injected into the retry prompt so the agent has context to fix the issues. Each retry also escalates the session's [effort](#per-issue-model--effort) one tier (capped at `max`), keeping the model fixed.

### Task Decomposition

Use `--decompose` to invoke an LLM to break a feature description into structured issues:

```bash
echo "Add user authentication with OAuth" | npx tsx orchestrate.ts myconfig --decompose
npx tsx orchestrate.ts myconfig --decompose --file spec.md
npx tsx orchestrate.ts myconfig --decompose --issue 42 --repo owner/repo
npx tsx orchestrate.ts myconfig --decompose --file spec.md --create-issues --repo owner/repo
```

### Web Dashboard

Use `--dashboard` to start a read-only HTTP dashboard with live status updates:

```bash
npx tsx orchestrate.ts myconfig --dashboard              # http://127.0.0.1:3000
npx tsx orchestrate.ts myconfig --dashboard --port 8080   # custom port
```

The dashboard shows issues grouped by wave with status badges, PR links, and expandable log tails. Updates are streamed via Server-Sent Events.

## Test Utilities

Import test helpers from `claude-orchestrator/testing`:

```typescript
import { InMemoryStatusStore, InMemoryMetadataStore, createSilentLogger } from "@funlandresearch/claude-orchestrator/testing";
```

## Development

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```

## License

MIT
