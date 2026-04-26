import { execSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrintSummary } from "./summary.js";
import { interpolate } from "./interpolate.js";
import { createLabelSyncHandler } from "./label-sync.js";
import { detectCollisions, gatherCollisionInputs } from "./collision-check.js";
function defaultClaimHelperPath() {
    const here = fileURLToPath(import.meta.url);
    return path.join(path.dirname(here), "cli-claim.js");
}
export function buildClaimCommand(yamlPath, issueNumber, helperPath = defaultClaimHelperPath()) {
    return `node ${helperPath} --config ${yamlPath} --issue ${issueNumber} --domain`;
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
function buildTemplateVars(yaml, issue, deps) {
    const vars = {
        ISSUE_NUMBER: String(issue.number),
        SLUG: issue.slug,
        DESCRIPTION: issue.description,
        projectRoot: yaml.projectRoot,
        configDir: yaml.configDir,
        worktreeDir: yaml.worktreeDir,
    };
    if (yaml.sequentialDomains && deps.yamlPath) {
        vars.CLAIM_NUMBER = buildClaimCommand(deps.yamlPath, issue.number, deps.claimHelperPath);
    }
    return vars;
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
            const vars = buildTemplateVars(yaml, issue, deps);
            return yaml.claudeArgs.map((arg) => interpolate(arg, vars));
        },
        async interpolatePrompt(issue, extraVars) {
            if (!yaml.promptTemplate) {
                return `Fix issue #${issue.number}: ${issue.description}`;
            }
            const template = readFile
                ? readFile(yaml.promptTemplate)
                : (await import("node:fs")).readFileSync(yaml.promptTemplate, "utf-8");
            const vars = { ...buildTemplateVars(yaml, issue, deps), ...(extraVars ?? {}) };
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
    // Compile sequentialPaths regexes once. Bad regex / missing capture group
    // is rejected by zod at load time, so we just compile here.
    const sequentialEntries = yaml.sequentialPaths ?? [];
    const baseBranch = yaml.baseBranch ?? "main";
    // Attach postSessionCheck if either commands or sequentialPaths are set.
    if (yaml.postSessionCheck || sequentialEntries.length > 0) {
        const cmdConfig = yaml.postSessionCheck;
        hooks.postSessionCheck = async (issue, worktreePath) => {
            const run = runCommand ?? ((cmd, dir) => execSync(cmd, { cwd: dir, encoding: "utf-8" }));
            // 1. Run configured commands first; first failure short-circuits.
            if (cmdConfig) {
                const execDir = cmdConfig.cwd
                    ? path.join(worktreePath, cmdConfig.cwd)
                    : worktreePath;
                for (const cmd of cmdConfig.commands) {
                    try {
                        run(cmd, execDir);
                    }
                    catch (err) {
                        return {
                            passed: false,
                            summary: `Command failed: ${cmd}\n${err.message}`,
                            output: err.message,
                        };
                    }
                }
            }
            // 2. Sequential-file collision scan, when configured.
            if (sequentialEntries.length > 0) {
                const peers = yaml.issues
                    .filter((peer) => peer.number !== issue.number)
                    .map((peer) => ({
                    slug: peer.slug,
                    worktreePath: path.join(yaml.worktreeDir, peer.slug),
                }));
                const exists = deps.existsSync ?? fsExistsSync;
                const gitRun = (cmd) => run(cmd, worktreePath);
                const collisionInput = gatherCollisionInputs({
                    runCommand: gitRun,
                    existsSync: exists,
                    currentWorktree: worktreePath,
                    peers,
                    entries: sequentialEntries,
                    baseBranch,
                    onPeerError: (slug, err) => {
                        console.warn(`[collision-check] skipping peer ${slug}: ${err.message}`);
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
    // Attach label sync when configured
    if (yaml.labelSync) {
        const labelRepo = yaml.labelSync.repo ?? yaml.issues[0]?.repo ?? "";
        if (labelRepo) {
            hooks.onStatusChange = createLabelSyncHandler({ prefix: yaml.labelSync.prefix, repo: labelRepo }, {
                runCommand: (cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf-8" }),
                logger: { info() { }, warn(msg) { console.warn(msg); }, error() { }, step() { }, header() { } },
            });
        }
    }
    return hooks;
}
//# sourceMappingURL=yaml-hooks.js.map