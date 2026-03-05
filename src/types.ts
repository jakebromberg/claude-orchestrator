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
  dependsOn: number[];
  description: string;
  repo?: string;
  mode?: string;
  /** Override global stall timeout for this issue (seconds). 0 disables monitoring. */
  stallTimeout?: number;
}

export interface Issue extends IssueSpec {
  wave: number;
  deps: number[];
}

export interface RawOrchestratorConfig {
  name: string;
  configDir: string;
  worktreeDir: string;
  projectRoot: string;
  /** Stall timeout in seconds. 0 disables stall monitoring. */
  stallTimeout: number;
  issues: IssueSpec[];
  hooks: OrchestratorHooks;
  allowedTools?: string[];
}

export interface OrchestratorConfig {
  name: string;
  configDir: string;
  worktreeDir: string;
  projectRoot: string;
  /** Stall timeout in seconds. 0 disables stall monitoring. */
  stallTimeout: number;
  issues: Issue[];
  hooks: OrchestratorHooks;
  allowedTools?: string[];
}

export type MergePolicy = "none" | "after-wave";

export interface RunOptions {
  maxParallel?: number;
  mergePolicy?: MergePolicy;
}

export interface PostCheckResult {
  passed: boolean;
  summary?: string;
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
  interpolatePrompt(issue: Issue, extraVars?: Record<string, string>): Promise<string>;
  getClaudeArgs(issue: Issue): string[];
  printSummary(issues: Issue[], getStatus: (n: number) => Status): void;
  /** Optional hook called after Claude exits 0, before marking "succeeded". */
  postSessionCheck?(issue: Issue, worktreePath: string): Promise<PostCheckResult>;
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
  | "run-specific";

export interface ParsedArgs {
  mode: ParsedMode;
  wave?: number;
  issues: number[];
  maxParallel: number;
  mergeAfterWave: boolean;
  detach: boolean;
  notify: boolean;
}

export interface StatusStore {
  get(issueNumber: number): Status;
  set(issueNumber: number, status: Status): void;
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
}

export interface MetadataStore {
  get(issueNumber: number): IssueMetadata;
  set(issueNumber: number, metadata: IssueMetadata): void;
  update(issueNumber: number, partial: Partial<IssueMetadata>): void;
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
  statuses: Record<number, Status>;
}
