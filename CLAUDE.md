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
├── create-main.ts        # Generic entry point factory (sync or async ConfigFactory)
├── interpolate.ts        # {{var}} template substitution
├── yaml-types.ts         # YamlConfig, HooksOverride types
├── yaml-schema.ts        # Zod schema for YAML config validation
├── yaml-hooks.ts         # deriveHooks() — YAML fields → OrchestratorHooks
├── yaml-loader.ts        # loadYamlConfig() — full YAML→config pipeline
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

### Commands

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```
