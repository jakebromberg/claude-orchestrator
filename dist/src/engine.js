import { ProcessPool } from "./process-pool.js";
import { StallMonitor } from "./stall-monitor.js";
import { extractPrUrl } from "./pr-tracker.js";
import { mergePrs } from "./merge.js";
import { gatherUpstreamContext } from "./upstream-context.js";
const STALL_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_ALLOWED_TOOLS = [
    "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "Task",
];
export class Orchestrator {
    config;
    deps;
    maxParallel;
    mergePolicy;
    constructor(config, deps, options) {
        this.config = config;
        this.deps = deps;
        this.maxParallel = options?.maxParallel ?? 4;
        this.mergePolicy = options?.mergePolicy ?? "none";
    }
    checkPrerequisites() {
        if (!this.deps.commandExists("claude")) {
            throw new Error("claude CLI not found. Install Claude Code first.");
        }
        if (!this.deps.commandExists("gh")) {
            throw new Error("gh CLI not found. Install: brew install gh");
        }
    }
    async resetStaleStatuses() {
        const promises = [];
        for (const issue of this.config.issues) {
            if (this.deps.statusStore.get(issue.number) === "running") {
                this.deps.logger.warn(`Issue #${issue.number} has stale 'running' status, resetting to pending`);
                promises.push(this.setStatus(issue, "pending"));
            }
        }
        await Promise.allSettled(promises);
    }
    async handleInterrupt() {
        const promises = [];
        for (const issue of this.config.issues) {
            if (this.deps.statusStore.get(issue.number) === "running") {
                promises.push(this.setStatus(issue, "interrupted"));
            }
        }
        await Promise.allSettled(promises);
        this.config.hooks.printSummary(this.config.issues, (n) => this.deps.statusStore.get(n));
    }
    async runWave(wave) {
        this.deps.logger.header(`Running Wave ${wave}`);
        const waveIssues = this.config.issues.filter((i) => i.wave === wave);
        const ready = await this.prepareIssues(waveIssues);
        await this.launchAndWait(ready);
    }
    async runAllWaves() {
        const waves = [
            ...new Set(this.config.issues.map((i) => i.wave)),
        ].sort((a, b) => a - b);
        for (const wave of waves) {
            await this.runWave(wave);
            if (this.mergePolicy === "after-wave") {
                const waveIssues = this.config.issues.filter((i) => i.wave === wave);
                this.deps.logger.info(`Merging wave ${wave} PRs...`);
                const mergeResults = mergePrs(waveIssues, {
                    getStatus: (n) => this.deps.statusStore.get(n),
                    getMetadata: (n) => this.deps.metadataStore.get(n),
                    runCommand: (cmd) => this.deps.runCommand(cmd),
                    logger: this.deps.logger,
                    getWorktreePath: (issue) => this.config.hooks.getWorktreePath(issue),
                }, { admin: true });
                await cleanUpMergedIssues(waveIssues, mergeResults, {
                    removeWorktree: (issue) => this.config.hooks.removeWorktree(issue),
                    runCommand: (cmd) => this.deps.runCommand(cmd),
                    logger: this.deps.logger,
                    getBranchName: (issue) => this.config.hooks.getBranchName(issue),
                });
            }
        }
    }
    async runSpecific(issueNumbers) {
        this.deps.logger.header(`Running Specific Issues: ${issueNumbers.join(", ")}`);
        const issues = [];
        for (const num of issueNumbers) {
            const issue = this.config.issues.find((i) => i.number === num);
            if (!issue) {
                this.deps.logger.error(`Issue #${num} not found in config`);
                continue;
            }
            issues.push(issue);
        }
        const ready = await this.prepareIssues(issues);
        await this.launchAndWait(ready);
    }
    async retryFailed() {
        this.deps.logger.header("Retrying Failed Issues");
        const retryable = [];
        for (const issue of this.config.issues) {
            const status = this.deps.statusStore.get(issue.number);
            if (this.config.hooks.isRetryableStatus(status)) {
                await this.setStatus(issue, "pending");
                retryable.push(issue);
            }
        }
        if (retryable.length === 0) {
            this.deps.logger.info("No retryable issues found");
            return;
        }
        const ready = await this.prepareIssues(retryable);
        await this.launchAndWait(ready);
    }
    async cleanup() {
        this.deps.logger.header("Cleaning Up");
        for (const issue of this.config.issues) {
            await this.config.hooks.removeWorktree(issue);
        }
        this.deps.logger.info("Cleanup complete");
    }
    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------
    async setStatus(issue, newStatus) {
        const oldStatus = this.deps.statusStore.get(issue.number);
        this.deps.statusStore.set(issue.number, newStatus);
        if (this.config.hooks.onStatusChange) {
            try {
                await this.config.hooks.onStatusChange(issue, oldStatus, newStatus);
            }
            catch (err) {
                this.deps.logger.warn(`onStatusChange hook error for #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    async prepareIssues(issues) {
        const ready = [];
        for (const issue of issues) {
            // Skip already succeeded
            const currentStatus = this.deps.statusStore.get(issue.number);
            if (currentStatus === "succeeded") {
                this.deps.logger.info(`Issue #${issue.number} already succeeded, skipping`);
                this.refreshMetadata(issue);
                continue;
            }
            // Let the wrapper skip issues
            const skipResult = this.config.hooks.shouldSkipIssue(issue);
            if (skipResult.skip) {
                continue;
            }
            // Check dependencies
            if (!await this.checkDeps(issue)) {
                continue;
            }
            // Set up worktree
            try {
                await this.config.hooks.setUpWorktree(issue);
            }
            catch (err) {
                this.deps.logger.error(`Issue #${issue.number}: failed to set up worktree`);
                await this.setStatus(issue, "failed");
                continue;
            }
            // Gather upstream context from dependency worktrees
            const upstreamContext = gatherUpstreamContext(issue, this.config.issues, {
                readFile: (p) => this.deps.readFile(p),
                getWorktreePath: (i) => this.config.hooks.getWorktreePath(i),
            });
            const extraVars = upstreamContext
                ? { UPSTREAM_CONTEXT: upstreamContext }
                : undefined;
            // Build prompt
            const prompt = await this.config.hooks.interpolatePrompt(issue, extraVars);
            const sessionId = this.deps.generateSessionId();
            ready.push({ issue, prompt, sessionId });
        }
        return ready;
    }
    async checkDeps(issue) {
        for (const depNum of issue.deps) {
            const depStatus = this.deps.statusStore.get(depNum);
            if (depStatus !== "succeeded") {
                this.deps.logger.warn(`Issue #${issue.number} skipped: dependency #${depNum} has status '${depStatus}'`);
                await this.setStatus(issue, "skipped");
                return false;
            }
        }
        return true;
    }
    refreshMetadata(issue) {
        const logFile = `${this.config.configDir}/logs/issue-${issue.number}.log`;
        try {
            const logContent = this.deps.readFile(logFile);
            const pr = extractPrUrl(logContent);
            if (pr) {
                this.deps.metadataStore.update(issue.number, {
                    prUrl: pr.url,
                    prNumber: pr.number,
                });
            }
            // If no PR URL found in log, do NOT clear existing metadata
            // (the log might be truncated or from a different run)
        }
        catch {
            // Log file may not exist — this is fine, just skip
        }
    }
    async launchAndWait(ready) {
        const pool = new ProcessPool(this.maxParallel);
        let fallbackTriggered = false;
        const postCheckPromises = [];
        for (const { issue, prompt, sessionId } of ready) {
            await pool.waitForSlot();
            await this.setStatus(issue, "running");
            this.deps.logger.step(`Launching Claude session for issue #${issue.number}: ${issue.description}`);
            const worktreePath = this.config.hooks.getWorktreePath(issue);
            const extraArgs = this.config.hooks.getClaudeArgs(issue);
            const logFile = `${this.config.configDir}/logs/issue-${issue.number}.log`;
            const tools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
            const args = [
                "-p",
                prompt,
                "--model",
                "opus",
                "--allowedTools",
                tools.join(","),
                ...extraArgs,
                "--output-format",
                "stream-json",
                "--include-hook-events",
                "--session-id",
                sessionId,
                "--verbose",
            ];
            const launchTime = new Date().toISOString();
            this.deps.metadataStore.update(issue.number, { startedAt: launchTime });
            const stderrFile = `${this.config.configDir}/logs/issue-${issue.number}.stderr.log`;
            const handle = this.deps.processRunner.spawn("claude", args, { cwd: worktreePath, logFile, stderrFile });
            handle.issueNumber = issue.number;
            let monitor = null;
            const effectiveStallTimeout = issue.stallTimeout ?? this.config.stallTimeout;
            if (effectiveStallTimeout > 0) {
                monitor = new StallMonitor({
                    stallTimeout: effectiveStallTimeout * 1000,
                    checkInterval: STALL_CHECK_INTERVAL_MS,
                    getLogSize: () => this.deps.getLogFileSize(logFile),
                    onStall: () => {
                        this.deps.logger.warn(`Issue #${issue.number} stalled (no output for ${effectiveStallTimeout}s), killing process`);
                        this.deps.processRunner.kill(handle.pid);
                    },
                });
                monitor.start();
            }
            const postCheck = handle.exitCode.then(async (exitCode) => {
                monitor?.stop();
                const finishTime = new Date().toISOString();
                this.deps.metadataStore.update(issue.number, {
                    exitCode,
                    finishedAt: finishTime,
                });
                // Extract PR URL from log file
                try {
                    const logContent = this.deps.readFile(logFile);
                    const pr = extractPrUrl(logContent);
                    if (pr) {
                        this.deps.metadataStore.update(issue.number, {
                            prUrl: pr.url,
                            prNumber: pr.number,
                        });
                        this.deps.logger.info(`Issue #${issue.number} created PR: ${pr.url}`);
                    }
                }
                catch {
                    // Log file may not exist if process was killed early
                }
                if (exitCode !== 0) {
                    if (this.isZeroByteLog(logFile)) {
                        // 0-byte stall — retry once
                        try {
                            const stderr = this.deps.readFile(stderrFile);
                            if (stderr.length > 0) {
                                this.deps.logger.warn(`Issue #${issue.number} stderr before retry:\n${stderr}`);
                            }
                        }
                        catch { }
                        this.deps.logger.warn(`Issue #${issue.number} produced 0-byte log (exit ${exitCode}), retrying once...`);
                        this.deps.truncateFile(logFile);
                        this.deps.truncateFile(stderrFile);
                        const retryHandle = this.deps.processRunner.spawn("claude", args, { cwd: worktreePath, logFile, stderrFile });
                        retryHandle.issueNumber = issue.number;
                        let retryMonitor = null;
                        const retryStallTimeout = issue.stallTimeout ?? this.config.stallTimeout;
                        if (retryStallTimeout > 0) {
                            retryMonitor = new StallMonitor({
                                stallTimeout: retryStallTimeout * 1000,
                                checkInterval: STALL_CHECK_INTERVAL_MS,
                                getLogSize: () => this.deps.getLogFileSize(logFile),
                                onStall: () => {
                                    this.deps.logger.warn(`Issue #${issue.number} retry stalled (no output for ${retryStallTimeout}s), killing process`);
                                    this.deps.processRunner.kill(retryHandle.pid);
                                },
                            });
                            retryMonitor.start();
                        }
                        const retryExitCode = await retryHandle.exitCode;
                        retryMonitor?.stop();
                        this.deps.metadataStore.update(issue.number, {
                            exitCode: retryExitCode,
                            finishedAt: new Date().toISOString(),
                        });
                        try {
                            const logContent = this.deps.readFile(logFile);
                            const pr = extractPrUrl(logContent);
                            if (pr) {
                                this.deps.metadataStore.update(issue.number, {
                                    prUrl: pr.url,
                                    prNumber: pr.number,
                                });
                                this.deps.logger.info(`Issue #${issue.number} created PR: ${pr.url}`);
                            }
                        }
                        catch { }
                        if (retryExitCode !== 0) {
                            if (this.isZeroByteLog(logFile) && !fallbackTriggered) {
                                fallbackTriggered = true;
                                pool.setMaxParallel(1);
                                this.deps.logger.warn(`Issue #${issue.number}: 0-byte failure persisted after retry, falling back to sequential execution`);
                            }
                            await this.setStatus(issue, "failed");
                            this.deps.logger.error(`Issue #${issue.number} retry failed (exit code ${retryExitCode}). Log: ${logFile}`);
                            return;
                        }
                        const zeroRetryCheck = await this.runPostSessionCheck(issue, worktreePath);
                        if (!await this.handleCheckResultWithRetry(issue, zeroRetryCheck, prompt, worktreePath, logFile, stderrFile))
                            return;
                        await this.setStatus(issue, "succeeded");
                        this.deps.logger.info(`Issue #${issue.number} succeeded (after retry)`);
                        return;
                    }
                    await this.setStatus(issue, "failed");
                    this.deps.logger.error(`Issue #${issue.number} failed (exit code ${exitCode}). Log: ${logFile}`);
                    return;
                }
                const checkResult = await this.runPostSessionCheck(issue, worktreePath);
                if (!await this.handleCheckResultWithRetry(issue, checkResult, prompt, worktreePath, logFile, stderrFile))
                    return;
                await this.setStatus(issue, "succeeded");
                this.deps.logger.info(`Issue #${issue.number} succeeded`);
            });
            postCheckPromises.push(postCheck);
            pool.add(handle);
        }
        await pool.waitAll();
        await Promise.all(postCheckPromises);
    }
    isZeroByteLog(logFile) {
        return this.deps.getLogFileSize(logFile) === 0;
    }
    async runPostSessionCheck(issue, worktreePath) {
        if (!this.config.hooks.postSessionCheck)
            return { passed: true };
        try {
            const result = await this.config.hooks.postSessionCheck(issue, worktreePath);
            if (!result.passed) {
                this.deps.logger.error(`Issue #${issue.number} post-check failed: ${result.summary ?? "unknown reason"}`);
            }
            return result;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.deps.logger.error(`Issue #${issue.number} post-check threw: ${msg}`);
            return { passed: false, output: msg, summary: msg };
        }
    }
    async handleCheckResultWithRetry(issue, checkResult, originalPrompt, worktreePath, logFile, stderrFile) {
        if (checkResult.passed)
            return true;
        const retryConfig = this.config.retryOnCheckFailure;
        if (!retryConfig?.enabled) {
            await this.setStatus(issue, "failed");
            return false;
        }
        const maxRetries = retryConfig.maxRetries;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            this.deps.logger.warn(`Issue #${issue.number} check failed, retry ${attempt}/${maxRetries}...`);
            const failureContext = checkResult.output ?? checkResult.summary ?? "unknown failure";
            const retryPrompt = `${originalPrompt}\n\n## CI Failure Context\n\nThe following checks failed:\n\n${failureContext}\n\nPlease fix these issues.`;
            const tools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
            const retryArgs = [
                "-p", retryPrompt,
                "--model", "opus",
                "--allowedTools", tools.join(","),
                ...this.config.hooks.getClaudeArgs(issue),
                "--output-format", "stream-json",
                "--verbose",
            ];
            const retryHandle = this.deps.processRunner.spawn("claude", retryArgs, { cwd: worktreePath, logFile, stderrFile });
            const retryExitCode = await retryHandle.exitCode;
            this.deps.metadataStore.update(issue.number, {
                exitCode: retryExitCode,
                finishedAt: new Date().toISOString(),
                retryCount: attempt,
            });
            if (retryExitCode !== 0) {
                await this.setStatus(issue, "failed");
                this.deps.logger.error(`Issue #${issue.number} retry ${attempt} exited with code ${retryExitCode}`);
                return false;
            }
            checkResult = await this.runPostSessionCheck(issue, worktreePath);
            if (checkResult.passed) {
                this.deps.logger.info(`Issue #${issue.number} succeeded after retry ${attempt}`);
                return true;
            }
        }
        // All retries exhausted
        await this.setStatus(issue, "failed");
        this.deps.logger.error(`Issue #${issue.number} failed after ${maxRetries} retries`);
        return false;
    }
}
/**
 * Clean up worktrees and remote branches for issues that were successfully merged.
 * Failures are non-fatal (logged as warnings) so one failed cleanup doesn't block others.
 */
export async function cleanUpMergedIssues(issues, mergeResults, deps) {
    for (const issue of issues) {
        if (mergeResults.get(issue.number) !== "merged")
            continue;
        try {
            await deps.removeWorktree(issue);
            deps.logger.info(`#${issue.number}: removed worktree`);
        }
        catch (err) {
            deps.logger.warn(`#${issue.number}: worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const branchName = deps.getBranchName(issue);
        try {
            deps.runCommand(`git push origin --delete ${branchName}`);
            deps.logger.info(`#${issue.number}: deleted remote branch ${branchName}`);
        }
        catch (err) {
            deps.logger.warn(`#${issue.number}: remote branch deletion failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=engine.js.map