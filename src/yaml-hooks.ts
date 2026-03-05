import path from "node:path";
import type { Issue, OrchestratorHooks, PostCheckResult, Status } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
import { createPrintSummary, type SummaryColumn } from "./summary.js";
import { interpolate } from "./interpolate.js";

/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
  readFile?: (path: string) => string;
  runCommand?: (cmd: string, cwd: string) => string;
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

function buildTemplateVars(yaml: YamlConfig, issue: Issue): Record<string, string> {
  return {
    ISSUE_NUMBER: String(issue.number),
    SLUG: issue.slug,
    DESCRIPTION: issue.description,
    projectRoot: yaml.projectRoot,
    configDir: yaml.configDir,
    worktreeDir: yaml.worktreeDir,
  };
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
      const vars = buildTemplateVars(yaml, issue);
      return yaml.claudeArgs.map((arg) => interpolate(arg, vars));
    },

    async interpolatePrompt(issue: Issue, extraVars?: Record<string, string>): Promise<string> {
      if (!yaml.promptTemplate) {
        return `Fix issue #${issue.number}: ${issue.description}`;
      }
      const template = readFile
        ? readFile(yaml.promptTemplate)
        : (await import("node:fs")).readFileSync(yaml.promptTemplate, "utf-8");
      const vars = { ...buildTemplateVars(yaml, issue), ...(extraVars ?? {}) };
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

  // Attach postSessionCheck only when configured
  if (yaml.postSessionCheck) {
    const { commands, cwd } = yaml.postSessionCheck;
    hooks.postSessionCheck = async (
      _issue: Issue,
      worktreePath: string,
    ): Promise<PostCheckResult> => {
      const execDir = cwd ? path.join(worktreePath, cwd) : worktreePath;
      const run = runCommand ?? ((cmd: string, dir: string) => {
        const { execSync } = require("node:child_process");
        return execSync(cmd, { cwd: dir, encoding: "utf-8" });
      });

      for (const cmd of commands) {
        try {
          run(cmd, execDir);
        } catch (err) {
          return {
            passed: false,
            summary: `Command failed: ${cmd}\n${(err as Error).message}`,
          };
        }
      }
      return { passed: true };
    };
  }

  return hooks;
}
