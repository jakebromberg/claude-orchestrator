import path from "node:path";
import { createPrintSummary } from "./summary.js";
import { interpolate } from "./interpolate.js";
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
function columnAccessor(valuePath, prefix) {
    if (!VALID_COLUMN_PATHS.has(valuePath)) {
        throw new Error(`Invalid column value path "${valuePath}". ` +
            `Valid paths: ${[...VALID_COLUMN_PATHS].join(", ")}`);
    }
    return (issue, status) => {
        let raw;
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
function buildTemplateVars(yaml, issue) {
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
export function deriveHooks(yaml, deps = {}) {
    const { readFile, runCommand } = deps;
    // Validate summary column paths eagerly
    const summaryColumns = yaml.summary
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
    const hooks = {
        getWorktreePath(issue) {
            return path.join(yaml.worktreeDir, issue.slug);
        },
        getBranchName(issue) {
            return branchPrefix + issue.slug;
        },
        isRetryableStatus(status) {
            return retryableSet.has(status);
        },
        shouldSkipIssue() {
            return { skip: false };
        },
        showHelp() {
            console.log(`${yaml.name}\n`);
            console.log("Issues:");
            for (const issue of yaml.issues) {
                const deps = issue.dependsOn.length
                    ? ` (depends on: ${issue.dependsOn.map((d) => "#" + d).join(", ")})`
                    : "";
                console.log(`  #${issue.number} ${issue.slug} — ${issue.description}${deps}`);
            }
        },
        getClaudeArgs(issue) {
            if (!yaml.claudeArgs)
                return [];
            const vars = buildTemplateVars(yaml, issue);
            return yaml.claudeArgs.map((arg) => interpolate(arg, vars));
        },
        async interpolatePrompt(issue) {
            if (!yaml.promptTemplate) {
                return `Fix issue #${issue.number}: ${issue.description}`;
            }
            const template = readFile
                ? readFile(yaml.promptTemplate)
                : (await import("node:fs")).readFileSync(yaml.promptTemplate, "utf-8");
            const vars = buildTemplateVars(yaml, issue);
            return interpolate(template, vars);
        },
        printSummary,
        async preflightCheck() { },
        async preRunSetup() { },
        async setUpWorktree(_issue) {
            throw new Error("setUpWorktree is not implemented by the YAML config layer. " +
                "Provide an override in your .hooks.ts file.");
        },
        async removeWorktree(_issue) {
            throw new Error("removeWorktree is not implemented by the YAML config layer. " +
                "Provide an override in your .hooks.ts file.");
        },
    };
    // Attach postSessionCheck only when configured
    if (yaml.postSessionCheck) {
        const { commands, cwd } = yaml.postSessionCheck;
        hooks.postSessionCheck = async (_issue, worktreePath) => {
            const execDir = cwd ? path.join(worktreePath, cwd) : worktreePath;
            const run = runCommand ?? ((cmd, dir) => {
                const { execSync } = require("node:child_process");
                return execSync(cmd, { cwd: dir, encoding: "utf-8" });
            });
            for (const cmd of commands) {
                try {
                    run(cmd, execDir);
                }
                catch (err) {
                    return {
                        passed: false,
                        summary: `Command failed: ${cmd}\n${err.message}`,
                    };
                }
            }
            return { passed: true };
        };
    }
    return hooks;
}
//# sourceMappingURL=yaml-hooks.js.map