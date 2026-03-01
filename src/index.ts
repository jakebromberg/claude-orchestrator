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
