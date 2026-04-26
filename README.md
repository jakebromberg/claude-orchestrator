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
  - { number: 3, slug: ui-tweak,      dependsOn: [], description: "Tweak button", }            # runs in parallel with #4
  - { number: 4, slug: docs-update,   dependsOn: [], description: "Update README" }            # runs in parallel with #3
```

This is a brute-force serialization — an issue that only depends on a non-serial sibling will still wait until any serial siblings in the same base wave finish. Use it sparingly, only on issues that genuinely conflict on shared sequential state.

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

Set `retryOnCheckFailure: { maxRetries: 2 }` in YAML to automatically retry agent sessions when `postSessionCheck` fails. The failure output is injected into the retry prompt so the agent has context to fix the issues.

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
