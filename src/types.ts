export type Status =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface IssueSpec {
  number: number;
  slug: string;
  /**
   * Issues this one depends on. Each entry is either a bare number/numeric
   * string (same repo as this issue) or a fully-qualified cross-repo ref
   * `"owner/repo#N"`. Normalized to dep refs by the DAG layer.
   */
  dependsOn: (number | string)[];
  description: string;
  repo?: string;
  /**
   * Marks a non-Claude DAG node: `deploy` | `publish` | `gate`. A mode-node
   * runs its {@link command} (or acts as a manual gate) instead of spawning a
   * `claude -p` session — no worktree, no model/effort. See `mode-node.ts`.
   */
  mode?: string;
  /**
   * Shell command a mode-node runs in place of a Claude session (e.g.
   * `gh workflow run deploy.yml -R WXYC/library-metadata-lookup`). Exit 0 marks
   * the node succeeded; any non-zero exit marks it failed. Ignored for normal
   * (non-mode) issues.
   */
  command?: string;
  /**
   * Model for this issue's implement session — an alias (`haiku`/`sonnet`/`opus`)
   * or a full model id. Overrides the config-level `defaultModel`; falls back to
   * Sonnet. See `resolveModelEffort` in `model-effort.ts`.
   */
  model?: string;
  /**
   * Explicit effort tier (`low|medium|high|xhigh|max`) for this issue's session,
   * overriding the `complexity`-derived default.
   */
  effort?: string;
  /**
   * Complexity tag that sets the default effort when `effort` is unset:
   * `mechanical`→low, `normal`→medium, `complex`→high.
   */
  complexity?: string;
  /**
   * Extra read-only directories the agent may access (`claude --add-dir`), e.g.
   * a sibling repo whose types this issue consumes. In YAML configs, relative
   * paths resolve against the config file's directory.
   */
  extraDirs?: string[];
  /** Override global stall timeout for this issue (seconds). 0 disables monitoring. */
  stallTimeout?: number;
  /**
   * When true, this issue runs alone in its own wave — no other issue runs in
   * parallel with it. Use for issues that produce sequentially-numbered files
   * (e.g. SQL migrations) where parallel execution would cause naming
   * collisions. Trades parallelism for safety on the affected issues only.
   */
  serial?: boolean;
  /**
   * Paths to files this issue expects to write. The wave planner uses these to
   * detect same-file ownership conflicts across parallel issues and slides
   * conflicting issues into later waves. Files listed in the config-level
   * `sharedFiles` allowlist (or registered under `appendableFiles`) are exempt.
   */
  ownsFiles?: string[];
}

export interface Issue extends IssueSpec {
  wave: number;
  /** Composite identity: `"owner/repo#N"`, or bare `"N"` when no repo is known. */
  ref: string;
  /** Dependencies normalized to refs (see {@link IssueSpec.dependsOn}). */
  deps: string[];
}

export interface IssueCommentsConfig {
  repo: string;
  enabled: boolean;
}

export interface LabelSyncConfig {
  prefix: string;
  repo?: string;
}

export interface RawOrchestratorConfig {
  name: string;
  configDir: string;
  worktreeDir: string;
  projectRoot: string;
  /** Stall timeout in seconds. 0 disables stall monitoring. */
  stallTimeout: number;
  /** Repo assigned to issues without their own `repo`, for composite refs. */
  defaultRepo?: string;
  /** Default model for issues that don't set their own `model`. Falls back to Sonnet. */
  defaultModel?: string;
  /** Default effort tier for issues without an explicit `effort` or `complexity`. */
  defaultEffort?: string;
  issues: IssueSpec[];
  hooks: OrchestratorHooks;
  allowedTools?: string[];
  /** Post run summary comments on GitHub issues. */
  issueComments?: IssueCommentsConfig;
  /** Sync issue labels on status changes. */
  labelSync?: LabelSyncConfig;
  /** Auto-retry when postSessionCheck fails. */
  retryOnCheckFailure?: RetryOnCheckFailureConfig;
}

export interface OrchestratorConfig {
  name: string;
  configDir: string;
  worktreeDir: string;
  projectRoot: string;
  /** Stall timeout in seconds. 0 disables stall monitoring. */
  stallTimeout: number;
  /** Repo assigned to issues without their own `repo`, for composite refs. */
  defaultRepo?: string;
  /** Default model for issues that don't set their own `model`. Falls back to Sonnet. */
  defaultModel?: string;
  /** Default effort tier for issues without an explicit `effort` or `complexity`. */
  defaultEffort?: string;
  issues: Issue[];
  hooks: OrchestratorHooks;
  allowedTools?: string[];
  /** Post run summary comments on GitHub issues. */
  issueComments?: IssueCommentsConfig;
  /** Sync issue labels on status changes. */
  labelSync?: LabelSyncConfig;
  /** Auto-retry when postSessionCheck fails. */
  retryOnCheckFailure?: RetryOnCheckFailureConfig;
}

export type MergePolicy = "none" | "after-wave";

export interface RunOptions {
  maxParallel?: number;
  mergePolicy?: MergePolicy;
}

export interface PostCheckResult {
  passed: boolean;
  /** Human-readable summary for logs. */
  summary?: string;
  /** Raw command output for machine consumption (injected into retry prompts). */
  output?: string;
}

export interface RetryOnCheckFailureConfig {
  maxRetries: number;
  enabled: boolean;
}

export interface OrchestratorHooks {
  showHelp(): void;
  shouldSkipIssue(issue: Issue): { skip: boolean; reason?: string };
  isRetryableStatus(status: Status): boolean;
  preflightCheck(): Promise<void>;
  preRunSetup(): Promise<void>;
  setUpWorktree(issue: Issue): Promise<void>;
  removeWorktree(issue: Issue): Promise<void>;
  getWorktreePath(issue: Issue): string;
  getBranchName(issue: Issue): string;
  /**
   * Optional: the base branch an issue's PR targets — its repo's own default
   * branch (iOS `master`, others `main`). Used by the merge step's intra-wave
   * rebase and conflict-resolution prompt so a cross-repo PR rebases onto the
   * right ref. When absent, the merge falls back to `"main"`.
   */
  getBaseBranch?(issue: Issue): string;
  interpolatePrompt(issue: Issue, extraVars?: Record<string, string>): Promise<string>;
  getClaudeArgs(issue: Issue): string[];
  printSummary(issues: Issue[], getStatus: (ref: string) => Status): void;
  /** Optional hook called after Claude exits 0, before marking "succeeded". */
  postSessionCheck?(issue: Issue, worktreePath: string): Promise<PostCheckResult>;
  /** Optional hook called when an issue's status changes. Errors are non-fatal. */
  onStatusChange?(issue: Issue, oldStatus: Status, newStatus: Status): Promise<void>;
  /**
   * Optional hook called when `gh pr merge` fails with a merge conflict.
   * Return `{ resolved: true }` to trigger a single merge retry.
   * Errors from this hook are non-fatal.
   */
  onMergeConflict?(issue: Issue, conflictFiles: string[], baseBranch: string): Promise<{ resolved: boolean; details?: string }>;
  /**
   * Optional human-in-the-loop cutover confirmation. Called before running an
   * issue that sits behind a cutover gate — a command-less manual gate, or a
   * bare cross-repo dependency (see `cutoverReason` in `mode-node.ts`). Return
   * `true` to release the issue, `false` to hold it (left pending; dependents
   * skip). When this hook is absent, gated issues hold by default — a cross-repo
   * run must wire it (or model explicit command mode-nodes) to progress. Errors
   * are treated as "not confirmed".
   */
  confirmCutover?(issue: Issue, reason: string): Promise<boolean>;
}

export type ParsedMode =
  | "help"
  | "status"
  | "watch"
  | "cleanup"
  | "merge"
  | "retry-failed"
  | "tail"
  | "run-all"
  | "run-specific"
  | "decompose"
  | "dashboard";

export interface ParsedArgs {
  mode: ParsedMode;
  wave?: number;
  issues: number[];
  maxParallel: number;
  mergeAfterWave: boolean;
  detach: boolean;
  notify: boolean;
  decomposeFile?: string;
  createIssues?: boolean;
  decomposeIssue?: number;
  decomposeRepo?: string;
  port?: number;
}

export interface StatusStore {
  get(ref: string): Status;
  set(ref: string, status: Status): void;
  /**
   * Discard recorded state for `ref`. Idempotent on absent state.
   *
   * Optional for backwards compatibility with downstream implementations that
   * predate this interface field; consumers should use optional-chaining when
   * invoking it. Both `InMemoryStatusStore` and `FileStatusStore` provide it.
   */
  remove?(ref: string): void;
}

export interface ProcessHandle {
  pid: number;
  issueNumber: number;
  exitCode: Promise<number>;
}

export interface ProcessRunner {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; logFile: string; stderrFile?: string },
  ): ProcessHandle;
  kill(pid: number): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  header(message: string): void;
}

export interface IssueMetadata {
  prUrl?: string;
  prNumber?: number;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  filesChanged?: string[];
  retryCount?: number;
}

export interface MetadataStore {
  get(ref: string): IssueMetadata;
  set(ref: string, metadata: IssueMetadata): void;
  update(ref: string, partial: Partial<IssueMetadata>): void;
  /**
   * Discard recorded metadata for `ref`. Idempotent on absent state.
   *
   * Optional for backwards compatibility with downstream implementations that
   * predate this interface field; consumers should use optional-chaining when
   * invoking it. Both `InMemoryMetadataStore` and `FileMetadataStore` provide it.
   */
  remove?(ref: string): void;
}

export interface Deps {
  statusStore: StatusStore;
  metadataStore: MetadataStore;
  processRunner: ProcessRunner;
  logger: Logger;
  generateSessionId(): string;
  commandExists(command: string): boolean;
  getLogFileSize(logFile: string): number;
  readFile(path: string): string;
  runCommand(cmd: string): string;
  truncateFile(path: string): void;
}

export interface RunRecord {
  id: string;
  configName: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  maxParallel: number;
  wave?: number;
  targetIssues?: number[];
  statuses: Record<string, Status>;
}
