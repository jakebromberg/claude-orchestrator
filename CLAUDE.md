## claude-orchestrator

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
├── watch.ts              # Live dashboard
├── pr-tracker.ts         # PR URL extraction from logs
├── merge.ts              # PR merge with rebase
├── run-history.ts        # Run record persistence
├── dependency-files.ts   # Dependency file detection
├── report.ts             # Post-run report generation
├── real-process-runner.ts # Real child_process spawner
├── create-main.ts        # Generic entry point factory
├── index.ts              # Public API barrel export
└── testing.ts            # Test utility exports
```

### Key Patterns

- **Dependency injection**: `Deps` interface for all external interactions
- **In-memory testing**: All behavioral tests use `InMemoryStatusStore`,
  `InMemoryMetadataStore`, `createSilentLogger`, and mock `ProcessRunner`
- **Wave scheduling**: `computeWaves()` topological sort from `dependsOn`
- **Config validation**: Zod schema in `validateConfig()` with cycle detection

### Commands

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```
