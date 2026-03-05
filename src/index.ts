// Core types
export type {
  Status, IssueSpec, Issue, RawOrchestratorConfig, OrchestratorConfig,
  MergePolicy, RunOptions, PostCheckResult, OrchestratorHooks,
  ParsedMode, ParsedArgs, StatusStore, ProcessHandle, ProcessRunner,
  Logger, IssueMetadata, MetadataStore, Deps, RunRecord,
} from "./types.js";

// Engine
export { Orchestrator, cleanUpMergedIssues } from "./engine.js";
export { validateConfig } from "./schema.js";
export { computeWaves } from "./dag.js";
export { parseArgs } from "./cli.js";

// Stores
export { FileStatusStore, FileMetadataStore, InMemoryStatusStore, InMemoryMetadataStore } from "./status.js";

// Logging & display
export { consoleLogger, createSilentLogger, colors } from "./log.js";
export { createPrintSummary } from "./summary.js";
export type { SummaryColumn, SummaryOptions } from "./summary.js";

// Process management
export { ProcessPool } from "./process-pool.js";
export { StallMonitor } from "./stall-monitor.js";
export type { StallMonitorOptions } from "./stall-monitor.js";

// Watch
export { startWatch, renderDashboard, readLastLogLine } from "./watch.js";
export type { WatchOptions, WatchHandle, RenderOptions, WriteFn, ReadFileTail } from "./watch.js";

// PR & merge
export { extractPrUrl } from "./pr-tracker.js";
export { mergePrs } from "./merge.js";
export type { MergeResult, MergeOptions, MergeDeps } from "./merge.js";

// History & reports
export { writeRunRecord, listRuns } from "./run-history.js";
export { getDependencyFiles } from "./dependency-files.js";
export { generateReport, formatReport } from "./report.js";
export type { ReportData } from "./report.js";

// Process runner & main factory
export { createRealProcessRunner } from "./real-process-runner.js";
export { createMain } from "./create-main.js";
export type { ConfigFactory, MainOptions } from "./create-main.js";

// YAML config
export { loadYamlConfig } from "./yaml-loader.js";
export type { LoadYamlConfigOptions } from "./yaml-loader.js";
export { deriveHooks } from "./yaml-hooks.js";
export type { DeriveHooksDeps } from "./yaml-hooks.js";
export { interpolate } from "./interpolate.js";
export type { YamlConfig, HooksOverride, YamlSummaryColumn, YamlSummary, YamlPostSessionCheck, YamlIssue } from "./yaml-types.js";

// Upstream context
export { gatherUpstreamContext } from "./upstream-context.js";
export type { UpstreamContextDeps } from "./upstream-context.js";

// GitHub integration
export { addIssueLabel, removeIssueLabel, postIssueComment, ensureLabelExists } from "./github.js";
export type { GitHubDeps, LabelOptions } from "./github.js";
