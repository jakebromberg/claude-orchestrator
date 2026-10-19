import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrintSummary } from "./summary.js";
import { interpolate } from "./interpolate.js";
import { createLabelSyncHandler } from "./label-sync.js";
import { detectCollisions, gatherCollisionInputs } from "./collision-check.js";
import { resolveRepoSettings } from "./repo-settings.js";
import { perIssueSpawnArgs } from "./model-effort.js";
import { shellQuote } from "./shell-quote.js";
import { claudeExecOptions } from "./claude-env.js";
import { acquireLease, defaultWarn } from "./lease.js";
import { formatPostCheckStop, refusalStopReason } from "./lease-messages.js";
import { stopAtCritical } from "./memory-pressure.js";
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** The largest delay `setTimeout` honours; Node fires a longer one after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;
/** How long a timed-out command's process group has between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000;
/**
 * The last `max` bytes of `buf`, moved forward past any UTF-8 continuation
 * bytes so that the tail never starts in the middle of a character.
 */
function utf8Tail(buf, max) {
    if (buf.length <= max)
        return buf;
    let start = buf.length - max;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80)
        start++;
    return buf.subarray(start);
}
/**
 * Runs `cmd` under `/bin/sh -c` without blocking the event loop, keeping only
 * the last 64 KiB of combined stdout/stderr. Resolves with that tail on exit 0;
 * rejects with an Error carrying the exit code (or signal) and the tail. The
 * exit code is also on the error as `status`, the field an `execSync` failure
 * uses; a timeout or a signal leaves it unset.
 *
 * `onSpawn` receives the child's PID. If it throws, the child is killed and
 * the promise rejects with that error, but only after the child has exited.
 *
 * `timeoutMs` (unset, 0, or above {@link MAX_TIMER_MS}: none) bounds the run. With
 * a bound the shell runs in its own process group, and on timeout the whole group
 * gets SIGTERM (as `execSync` sent the shell), so a script's trap can clean up and
 * a grandchild cannot carry on; any member still alive `killGraceMs` later gets
 * SIGKILL. The promise rejects at the timeout, without waiting for the pipes a
 * grandchild may still hold open. Without a bound the shell stays in the
 * engine's group, as before.
 */
export function runShellAsync(cmd, cwd, env, onSpawn, timeoutMs, killGraceMs = KILL_GRACE_MS) {
    const bounded = timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS;
    return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", cmd], {
            cwd,
            env: env ? { ...process.env, ...env } : process.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: bounded,
        });
        const signalGroup = (signal) => {
            if (child.pid === undefined)
                return;
            try {
                process.kill(-child.pid, signal);
            }
            catch {
                // ESRCH: every member has already exited.
            }
        };
        let graceTimer;
        let tail = Buffer.alloc(0);
        const collect = (chunk) => {
            tail = utf8Tail(Buffer.concat([tail, chunk]), OUTPUT_TAIL_BYTES);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        let onSpawnFailure;
        const timer = bounded
            ? setTimeout(() => {
                signalGroup("SIGTERM");
                graceTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
                reject(new Error(`Command timed out after ${timeoutMs} ms\n${tail.toString("utf-8")}`));
            }, timeoutMs)
            : undefined;
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            clearTimeout(graceTimer);
            if (onSpawnFailure)
                return reject(onSpawnFailure.error);
            const output = tail.toString("utf-8");
            if (code === 0)
                return resolve(output);
            const how = signal ? `signal ${signal}` : `exit code ${code}`;
            reject(Object.assign(new Error(`Command failed with ${how}\n${output}`), code === null ? {} : { status: code }));
        });
        if (child.pid !== undefined && onSpawn) {
            try {
                onSpawn(child.pid);
            }
            catch (error) {
                onSpawnFailure = { error };
                child.kill();
            }
        }
    });
}
const WAIT_LOG_INTERVAL_MS = 60_000;
/**
 * One lease slot for a whole post-session check, labelled with the issue so the holder file does not show its first
 * command. Waits with no cap; at `critical` it ends in a refusal once no live holder and no engine session is left to
 * relieve the pressure. The engine never inherits a holder id, so `inheritedHolderId` is dropped.
 */
function acquireCheckLease(lease, issue, cwd, command, runningSessions = () => 0) {
    let lastLogged;
    return acquireLease({ ...lease, inheritedHolderId: undefined }, { command, label: `post-check ${issue.ref}`, cwd }, {
        onWait: (s) => {
            if (lastLogged !== undefined && s.waitedMs - lastLogged < WAIT_LOG_INTERVAL_MS)
                return;
            lastLogged = s.waitedMs;
            // A throwing writer must never change what the check does.
            try {
                (lease.warn ?? defaultWarn)(`Issue #${issue.number} post-check waiting for a lease slot (${s.level}, ${s.live.length}/${s.capacity} slots held)`);
            }
            catch { }
        },
        stopWhen: (s) => stopAtCritical(s.level, s.live.length + runningSessions()),
    });
}
function defaultClaimHelperPath() {
    const here = fileURLToPath(import.meta.url);
    return path.join(path.dirname(here), "cli-claim.js");
}
export function buildClaimCommand(yamlPath, issueNumber, helperPath = defaultClaimHelperPath()) {
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
        getBaseBranch(issue) {
            // This issue's repo's own default branch (iOS `master`, others `main`),
            // resolved the same way postSessionCheck/onMergeConflict resolve it — so
            // the merge step rebases a cross-repo PR onto the correct ref.
            return resolveRepoSettings(yaml, issue.repo ?? yaml.defaultRepo).baseBranch;
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
                : readFileSync(yaml.promptTemplate, "utf-8");
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
    // Attach postSessionCheck if a check profile (commands or sequentialPaths) is
    // configured at the top level or for any repo in the `repos:` map. The
    // effective profile is resolved per-issue (by the issue's repo) at call time.
    const anyRepoHasCheck = Object.values(yaml.repos ?? {}).some((r) => r.postSessionCheck || (r.sequentialPaths?.length ?? 0) > 0);
    if (yaml.postSessionCheck ||
        (yaml.sequentialPaths?.length ?? 0) > 0 ||
        anyRepoHasCheck) {
        hooks.postSessionCheck = async (issue, worktreePath, ctx) => {
            // Resolve this issue's repo's effective check profile: its commands, its
            // collision domains, and — critically — its base branch (iOS `master`,
            // not `main`) so the diffs below target the right ref.
            const repoKey = issue.repo ?? yaml.defaultRepo;
            const settings = resolveRepoSettings(yaml, repoKey);
            const cmdConfig = settings.postSessionCheck;
            const sequentialEntries = settings.sequentialPaths;
            const baseBranch = settings.baseBranch;
            const run = runCommand ?? runShellAsync;
            // 1. Run configured commands first; first failure short-circuits. With a
            // lease, the whole loop holds one slot; a refusal skips the loop but not
            // the collision scan below, which only reads git.
            let stopped;
            if (cmdConfig) {
                const execDir = cmdConfig.cwd
                    ? path.join(worktreePath, cmdConfig.cwd)
                    : worktreePath;
                let slot;
                if (ctx?.lease) {
                    const got = await acquireCheckLease(ctx.lease, issue, execDir, cmdConfig.commands[0] ?? "", ctx.runningSessions);
                    if ("refused" in got)
                        stopped = got;
                    else
                        slot = got;
                }
                try {
                    for (const cmd of stopped ? [] : cmdConfig.commands) {
                        try {
                            await (slot ? run(cmd, execDir, slot.childEnv(), slot.setChildPid) : run(cmd, execDir));
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
                finally {
                    slot?.release();
                }
            }
            // 2. Sequential-file collision scan, when configured. Only same-repo
            // peers can collide on this repo's numbered files, and they share this
            // issue's base branch — so peers in other repos are excluded (a
            // cross-repo peer would also drag in the wrong base branch here).
            if (sequentialEntries.length > 0) {
                const peers = yaml.issues
                    .filter((peer) => (peer.repo ?? yaml.defaultRepo) === repoKey &&
                    peer.number !== issue.number)
                    .map((peer) => ({
                    slug: peer.slug,
                    worktreePath: path.join(yaml.worktreeDir, peer.slug),
                }));
                const exists = deps.existsSync ?? fsExistsSync;
                const gitRun = deps.runGitCommand ?? ((file, args) => execFileSync(file, args, { encoding: "utf-8" }));
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
            if (stopped) {
                return {
                    passed: false,
                    stopped: refusalStopReason(stopped),
                    summary: formatPostCheckStop(stopped),
                };
            }
            return { passed: true };
        };
    }
    // Attach onMergeConflict when mergeConflictRetry is enabled
    if (yaml.mergeConflictRetry?.enabled) {
        // This runner drives a `claude` session, so it gets the scrubbed session
        // env — otherwise an exported ANTHROPIC_API_KEY would bill conflict
        // resolution to the API instead of the Claude Code login. (The
        // postSessionCheck runner above deliberately keeps the full environment:
        // it runs the project's own commands, which may need those credentials.)
        const resolveRunCommand = runCommand
            ?? ((cmd, cwd) => execSync(cmd, claudeExecOptions({ cwd })));
        hooks.onMergeConflict = async (issue, conflictFiles, hookBaseBranch) => {
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
                await resolveRunCommand(cmd, worktreePath);
                return { resolved: true };
            }
            catch (err) {
                const details = err instanceof Error ? err.message : String(err);
                return { resolved: false, details };
            }
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