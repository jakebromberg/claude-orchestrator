import type { OrchestratorHooks } from "./types.js";

/** Column definition in a YAML config's summary section. */
export interface YamlSummaryColumn {
  header: string;
  width: number;
  /** Dot-path to the value, e.g. `"issue.number"` or `"status"`. */
  value: string;
  /** Optional prefix prepended to the resolved value (e.g. `"#"`). */
  prefix?: string;
}

/** Summary section of a YAML config. */
export interface YamlSummary {
  title: string;
  columns: YamlSummaryColumn[];
}

/** Post-session check section of a YAML config. */
export interface YamlPostSessionCheck {
  commands: string[];
  /** Working directory relative to the worktree root. */
  cwd?: string;
}

/**
 * One sequential-file domain to check for cross-worktree collisions.
 *
 * `dir` is a path relative to the worktree root. `pattern` is a regex string
 * that must contain at least one capture group; the first group is treated as
 * the unique key (typically a zero-padded number such as `0056`).
 */
export interface SequentialPathConfig {
  dir: string;
  pattern: string;
}

/** Issue definition in a YAML config. */
export interface YamlIssue {
  number: number;
  slug: string;
  dependsOn: number[];
  description: string;
  repo?: string;
  mode?: string;
  stallTimeout?: number;
  /** Run this issue alone in its own wave. See `IssueSpec.serial`. */
  serial?: boolean;
}

/**
 * Shape of a parsed YAML orchestrator config file.
 *
 * All path fields are resolved relative to the YAML file's directory
 * during loading.
 */
export interface YamlConfig {
  name: string;
  configDir: string;
  worktreeDir: string;
  projectRoot: string;
  stallTimeout: number;
  allowedTools?: string[];

  branchPrefix?: string;
  retryableStatuses?: string[];
  promptTemplate?: string;
  claudeArgs?: string[];
  postSessionCheck?: YamlPostSessionCheck;
  summary?: YamlSummary;
  /** Post run summary comments on GitHub issues. */
  issueComments?: { repo: string; enabled?: boolean };
  /** Sync issue labels on status changes. */
  labelSync?: { prefix: string; repo?: string };
  /** Auto-retry when postSessionCheck fails. */
  retryOnCheckFailure?: { maxRetries: number; enabled?: boolean };
  /** Base branch used for collision detection diffs. Default `"main"`. */
  baseBranch?: string;
  /**
   * Domains of sequentially-numbered files to check for collisions across
   * peer worktrees. Detection runs inside `postSessionCheck` after configured
   * commands pass.
   */
  sequentialPaths?: SequentialPathConfig[];
  issues: YamlIssue[];
}

/**
 * Type for optional hook overrides exported from a `.hooks.ts` companion file.
 */
export type HooksOverride = Partial<OrchestratorHooks>;
