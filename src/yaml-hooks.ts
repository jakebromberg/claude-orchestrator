import { execFileSync, execSync } from "node:child_process";
import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue, OrchestratorHooks, PostCheckResult, Status } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
import { createPrintSummary, type SummaryColumn } from "./summary.js";
import { interpolate } from "./interpolate.js";
import { createLabelSyncHandler } from "./label-sync.js";
import { detectCollisions, gatherCollisionInputs } from "./collision-check.js";
import { resolveRepoSettings } from "./repo-settings.js";
import { perIssueSpawnArgs } from "./model-effort.js";
import { shellQuote } from "./shell-quote.js";

/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
  readFile?: (path: string) => string;
  runCommand?: (cmd: string, cwd: string) => string;
  /**
   * Used by collision detection to run git commands with an argument array
   * (avoids shell quoting entirely). Defaults to `execFileSync`.
   */
  runGitCommand?: (file: string, args: string[]) => string;
  /**
   * Used by collision detection to check whether a peer's worktree directory
   * is present on disk. Defaults to `node:fs.existsSync`.
   */
  existsSync?: (path: string) => boolean;
  /**
   * Absolute path to the YAML config. Required for `{{CLAIM_NUMBER}}` prompt
   * variable expansion (the resolved command embeds `--config <yamlPath>`).
   * Set automatically by `loadYamlConfig`; tests can pass it explicitly.
   */
  yamlPath?: string;
  /**
   * Override the resolved path to `cli-claim.js`. Defaults to the file
   * sibling of `yaml-hooks.js` in the package install. Set in tests to
   * decouple from the file system.
   */
  claimHelperPath?: string;
}

function defaultClaimHelperPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "cli-claim.js");
}

export function buildClaimCommand(
  yamlPath: string,
  issueNumber: number,
  helperPath: string = defaultClaimHelperPath(),
): string {
  return `node ${shellQuote(helperPath)} --config ${shellQuote(yamlPath)} --issue ${issueNumber} --domain`;
}

const VALID_COLUMN_PATHS = new Set([
  "issue.number",
  "issue.slug",
  "issue.description",
  "issue.wave",
  "status",
]);

/**
 * Maps a YAML column `value` string (e.g. `"issue.number"`) to a
 * `SummaryColumn.value` function. Validates the path at config load time.
 */
function columnAccessor(
  valuePath: string,
  prefix?: string,
): (issue: Issue, status: Status) => string {
  if (!VALID_COLUMN_PATHS.has(valuePath)) {
    throw new Error(
      `Invalid column value path "${valuePath}". ` +
        `Valid paths: ${[...VALID_COLUMN_PATHS].join(", ")}`,
    );
  }

  return (issue: Issue, status: Status): string => {
    let raw: string;
    switch (valuePath) {
      case "issue.number":
        raw = String(issue.number);
        break;
      case "issue.slug":
        raw = issue.slug;
        break;
      case "issue.description":
        raw = issue.description;
        break;
      case "issue.wave":
        raw = String(issue.wave);
        break;
      case "status":
        raw = status;
        break;
      default:
        raw = "";
    }
    return prefix ? prefix + raw : raw;
  };
}

function buildTemplateVars(
  yaml: YamlConfig,
  issue: Issue,
  deps: DeriveHooksDeps,
): Record<string, string> {
  const vars: Record<string, string> = {
    ISSUE_NUMBER: String(issue.number),
    SLUG: issue.slug,
    DESCRIPTION: issue.description,
    projectRoot: yaml.projectRoot,
    configDir: yaml.configDir,
    worktreeDir: yaml.worktreeDir,
  };
  if (yaml.sequentialDomains && deps.yamlPath) {
    vars.CLAIM_NUMBER = buildClaimCommand(
      deps.yamlPath,
      issue.number,
      deps.claimHelperPath,
    );
  }
  return vars;
}

/**
 * Derive a full `OrchestratorHooks` object from a parsed YAML config.
 *
 * Pure function with respect to `yaml` — only uses injected `deps` for I/O
 * (reading prompt templates, running post-session commands).
 */
export function deriveHooks(
  yaml: YamlConfig,
  deps: DeriveHooksDeps = {},
): OrchestratorHooks {
  const { readFile, runCommand } = deps;

  // Validate summary column paths eagerly
  const summaryColumns: SummaryColumn[] = yaml.summary
    ? yaml.summary.columns.map((col) => ({
        header: col.header,
        width: col.width,
        value: columnAccessor(col.value, col.prefix),
      }))
    : [
        { header: "#", width: 6, value: columnAccessor("issue.number", "#") },
        { header: "Description", width: 30, value: columnAccessor("issue.description") },
        { header: "Wave", width: 6, value: columnAccessor("issue.wave") },
        { header: "Status", width: 14, value: columnAccessor("status") },
      ];

  const printSummary = createPrintSummary({
    title: yaml.summary?.title ?? yaml.name,
    columns: summaryColumns,
  });

  const branchPrefix = yaml.branchPrefix ?? "orchestrator/";
  const retryableSet = new Set(yaml.retryableStatuses ?? ["failed"]);

  const hooks: OrchestratorHooks = {
    getWorktreePath(issue: Issue): string {
      return path.join(yaml.worktreeDir, issue.slug);
    },

    getBranchName(issue: Issue): string {
      return branchPrefix + issue.slug;
    },

    isRetryableStatus(status: Status): boolean {
      return retryableSet.has(status);
    },

    shouldSkipIssue(): { skip: boolean; reason?: string } {
      return { skip: false };
    },

    showHelp(): void {
      console.log(`${yaml.name}\n`);
      console.log("Issues:");
      for (const issue of yaml.issues) {
        const deps = issue.dependsOn.length
          ? ` (depends on: ${issue.dependsOn.map((d) => "#" + d).join(", ")})`
          : "";
        console.log(`  #${issue.number} ${issue.slug} — ${issue.description}${deps}`);
      }
    },

    getClaudeArgs(issue: Issue): string[] {
      if (!yaml.claudeArgs) return [];
      const vars = buildTemplateVars(yaml, issue, deps);
      return yaml.claudeArgs.map((arg) => interpolate(arg, vars));
    },

    async interpolatePrompt(issue: Issue, extraVars?: Record<string, string>): Promise<string> {
      if (!yaml.promptTemplate) {
        return `Fix issue #${issue.number}: ${issue.description}`;
      }
      const template = readFile
        ? readFile(yaml.promptTemplate)
        : readFileSync(yaml.promptTemplate, "utf-8");
      const vars = { ...buildTemplateVars(yaml, issue, deps), ...(extraVars ?? {}) };
      return interpolate(template, vars);
    },

    printSummary,

    async preflightCheck(): Promise<void> {},
    async preRunSetup(): Promise<void> {},

    async setUpWorktree(_issue: Issue): Promise<void> {
      throw new Error(
        "setUpWorktree is not implemented by the YAML config layer. " +
          "Provide an override in your .hooks.ts file.",
      );
    },

    async removeWorktree(_issue: Issue): Promise<void> {
      throw new Error(
        "removeWorktree is not implemented by the YAML config layer. " +
          "Provide an override in your .hooks.ts file.",
      );
    },
  };

  // Attach postSessionCheck if a check profile (commands or sequentialPaths) is
  // configured at the top level or for any repo in the `repos:` map. The
  // effective profile is resolved per-issue (by the issue's repo) at call time.
  const anyRepoHasCheck = Object.values(yaml.repos ?? {}).some(
    (r) => r.postSessionCheck || (r.sequentialPaths?.length ?? 0) > 0,
  );
  if (
    yaml.postSessionCheck ||
    (yaml.sequentialPaths?.length ?? 0) > 0 ||
    anyRepoHasCheck
  ) {
    hooks.postSessionCheck = async (
      issue: Issue,
      worktreePath: string,
    ): Promise<PostCheckResult> => {
      // Resolve this issue's repo's effective check profile: its commands, its
      // collision domains, and — critically — its base branch (iOS `master`,
      // not `main`) so the diffs below target the right ref.
      const repoKey = issue.repo ?? yaml.defaultRepo;
      const settings = resolveRepoSettings(yaml, repoKey);
      const cmdConfig = settings.postSessionCheck;
      const sequentialEntries = settings.sequentialPaths;
      const baseBranch = settings.baseBranch;

      const run = runCommand ?? ((cmd: string, dir: string) =>
        execSync(cmd, { cwd: dir, encoding: "utf-8" }));

      // 1. Run configured commands first; first failure short-circuits.
      if (cmdConfig) {
        const execDir = cmdConfig.cwd
          ? path.join(worktreePath, cmdConfig.cwd)
          : worktreePath;
        for (const cmd of cmdConfig.commands) {
          try {
            run(cmd, execDir);
          } catch (err) {
            return {
              passed: false,
              summary: `Command failed: ${cmd}\n${(err as Error).message}`,
              output: (err as Error).message,
            };
          }
        }
      }

      // 2. Sequential-file collision scan, when configured. Only same-repo
      // peers can collide on this repo's numbered files, and they share this
      // issue's base branch — so peers in other repos are excluded (a
      // cross-repo peer would also drag in the wrong base branch here).
      if (sequentialEntries.length > 0) {
        const peers = yaml.issues
          .filter(
            (peer) =>
              (peer.repo ?? yaml.defaultRepo) === repoKey &&
              peer.number !== issue.number,
          )
          .map((peer) => ({
            slug: peer.slug,
            worktreePath: path.join(yaml.worktreeDir, peer.slug),
          }));

        const exists = deps.existsSync ?? fsExistsSync;
        const gitRun: (file: string, args: string[]) => string =
          deps.runGitCommand ?? ((file, args) => execFileSync(file, args, { encoding: "utf-8" }));

        const collisionInput = gatherCollisionInputs({
          runCommand: gitRun,
          existsSync: exists,
          currentWorktree: worktreePath,
          peers,
          entries: sequentialEntries,
          baseBranch,
          onPeerError: (slug, err) => {
            console.warn(
              `[collision-check] skipping peer ${slug}: ${err.message}`,
            );
          },
        });
        const result = detectCollisions(collisionInput);
        if (result.collided) {
          return {
            passed: false,
            summary: result.summary,
            output: result.output,
          };
        }
      }

      return { passed: true };
    };
  }

  // Attach onMergeConflict when mergeConflictRetry is enabled
  if (yaml.mergeConflictRetry?.enabled) {
    const resolveRunCommand = runCommand
      ?? ((cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf-8" }));

    hooks.onMergeConflict = async (
      issue: Issue,
      conflictFiles: string[],
      hookBaseBranch: string,
    ): Promise<{ resolved: boolean; details?: string }> => {
      const worktreePath = path.join(yaml.worktreeDir, issue.slug);
      const fileList = conflictFiles.length > 0
        ? conflictFiles.join("\n")
        : "(run `git status` to see any conflicting files)";

      const prompt = [
        `The PR for issue #${issue.number} has merge conflicts after rebasing`,
        `against the latest ${hookBaseBranch}. The conflicts are:`,
        ``,
        fileList,
        ``,
        `Resolve each conflict, ensuring the combined change makes semantic sense`,
        `in light of what landed on ${hookBaseBranch} between this branch's start and`,
        `now. Run the project's test suite and fix any test failures the rebase`,
        `introduces. Then \`git push --force-with-lease\`.`,
      ].join("\n");

      const tools = yaml.allowedTools ?? [
        "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      ];

      // Same per-issue model/effort (+ --add-dir) the implement session used, so
      // conflict resolution runs at the issue's chosen tier rather than a fixed
      // model. Each token is shell-quoted since this is a joined command string.
      const perIssueArgs = perIssueSpawnArgs(issue, yaml).map(shellQuote);

      const cmd = [
        "claude",
        "-p",
        shellQuote(prompt),
        ...perIssueArgs,
        "--allowedTools",
        shellQuote(tools.join(",")),
        "--output-format",
        "stream-json",
        "--verbose",
      ].join(" ");

      try {
        resolveRunCommand(cmd, worktreePath);
        return { resolved: true };
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        return { resolved: false, details };
      }
    };
  }

  // Attach label sync when configured
  if (yaml.labelSync) {
    const labelRepo = yaml.labelSync.repo ?? yaml.issues[0]?.repo ?? "";
    if (labelRepo) {
      hooks.onStatusChange = createLabelSyncHandler(
        { prefix: yaml.labelSync.prefix, repo: labelRepo },
        {
          runCommand: (cmd: string) =>
            execSync(cmd, { stdio: "pipe", encoding: "utf-8" }),
          logger: { info() {}, warn(msg: string) { console.warn(msg); }, error() {}, step() {}, header() {} },
        },
      );
    }
  }

  return hooks;
}
