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

Create an entry point that registers your project-specific configs:

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

Run it:

```bash
npx tsx orchestrate.ts myconfig              # Run all waves
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

## YAML Configuration

For configs that don't need custom hook logic, use a YAML file instead of
TypeScript. Create `orchestrator.yaml`:

```yaml
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
  - { number: 2, slug: build, dependsOn: [1], description: "Build pipeline" }
```

Paths in the YAML file are resolved relative to the file's directory. Hook
defaults are derived from the YAML fields (branch naming, retry logic, summary
table, etc.). `setUpWorktree` and `removeWorktree` have no universal default
and must be provided as overrides.

Wire it up with an optional `.hooks.ts` override file:

```typescript
// orchestrate.ts
import { createMain, loadYamlConfig } from "claude-orchestrator";
import type { HooksOverride } from "claude-orchestrator";

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

`ConfigFactory` now accepts both sync and async return values, so
`loadYamlConfig` (which is async) works directly with `createMain`.

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
| `postSessionCheck?(issue, path)` | Optional post-session validation |

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
