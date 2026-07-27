import { ProcessPool } from "./process-pool.js";
import { StallMonitor } from "./stall-monitor.js";
import { extractPrUrl } from "./pr-tracker.js";
import { mergePrs } from "./merge.js";
import { gatherUpstreamContext } from "./upstream-context.js";
import { encodeRefForFilename } from "./ref.js";
import { perIssueSpawnArgs } from "./model-effort.js";
import { isModeNode, isCommandNode, cutoverReason } from "./mode-node.js";
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
            if (this.deps.statusStore.get(issue.ref) === "running") {
                this.deps.logger.warn(`Issue #${issue.number} has stale 'running' status, resetting to pending`);
                promises.push(this.setStatus(issue, "pending"));
            }
        }
        await Promise.allSettled(promises);
    }
    async handleInterrupt() {
        const promises = [];
        for (const issue of this.config.issues) {
            if (this.deps.statusStore.get(issue.ref) === "running") {
                promises.push(this.setStatus(issue, "interrupted"));
            }
        }
        await Promise.allSettled(promises);
        this.config.hooks.printSummary(this.config.issues, (n) => this.deps.statusStore.get(n));
    }
    async runWave(wave) {
        this.deps.logger.header(`Running Wave ${wave}`);
        const waveIssues = this.config.issues.filter((i) => i.wave === wave);
        await this.dispatchIssues(waveIssues);
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
                const mergeResults = await mergePrs(waveIssues, {
                    getStatus: (n) => this.deps.statusStore.get(n),
                    getMetadata: (n) => this.deps.metadataStore.get(n),
                    runCommand: (cmd) => this.deps.runCommand(cmd),
                    logger: this.deps.logger,
                    getWorktreePath: (issue) => this.config.hooks.getWorktreePath(issue),
                    onMergeConflict: this.config.hooks.onMergeConflict?.bind(this.config.hooks),
                    getBaseBranch: (issue) => this.config.hooks.getBaseBranch?.(issue),
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
        await this.dispatchIssues(issues);
    }
    async retryFailed() {
        this.deps.logger.header("Retrying Failed Issues");
        const retryable = [];
        for (const issue of this.config.issues) {
            const status = this.deps.statusStore.get(issue.ref);
            if (this.config.hooks.isRetryableStatus(status)) {
                await this.setStatus(issue, "pending");
                retryable.push(issue);
            }
        }
        if (retryable.length === 0) {
            this.deps.logger.info("No retryable issues found");
            return;
        }
        await this.dispatchIssues(retryable);
    }
    async cleanup() {
        this.deps.logger.header("Cleaning Up");
        for (const issue of this.config.issues) {
            // Mode-nodes (deploy/publish/gate) have no worktree — nothing to remove.
            if (!isModeNode(issue))
                await this.config.hooks.removeWorktree(issue);
            // Discard transient run state so the next wave starts from a clean slate.
            // Logs, run history, and per-domain counters are intentionally preserved.
            // `remove` is optional on both store interfaces (backwards-compat); a
            // downstream impl that predates the field is treated as "leaves state in
            // place," which is no worse than the previous behaviour.
            this.deps.statusStore.remove?.(issue.ref);
            this.deps.metadataStore.remove?.(issue.ref);
        }
        this.deps.logger.info("Cleanup complete");
    }
    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------
    async setStatus(issue, newStatus) {
        const oldStatus = this.deps.statusStore.get(issue.ref);
        this.deps.statusStore.set(issue.ref, newStatus);
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
        const modeNodes = [];
        // Lookup for cutover-gate detection (resolve a dep ref to its issue).
        const byRef = new Map(this.config.issues.map((i) => [i.ref, i]));
        for (const issue of issues) {
            // Skip already succeeded
            const currentStatus = this.deps.statusStore.get(issue.ref);
            if (currentStatus === "succeeded") {
                this.deps.logger.info(`Issue #${issue.number} already succeeded, skipping`);
                this.refreshMetadata(issue);
                continue;
            }
            // Let the wrapper skip issues. Write succeeded so dependents see this
            // dep as fulfilled — a skip-return means the work is done by other means.
            const skipResult = this.config.hooks.shouldSkipIssue(issue);
            if (skipResult.skip) {
                await this.setStatus(issue, "succeeded");
                continue;
            }
            // Check dependencies
            if (!await this.checkDeps(issue)) {
                continue;
            }
            // Cutover gate: a manual gate node or a bare cross-repo dependency stops
            // for human confirmation before this issue is released. Deps are already
            // satisfied here — this is the "satisfied ≠ consumable across a repo
            // boundary" checkpoint. Unconfirmed → hold (left pending; a re-run picks
            // it up once the upstream is deployed/published or the hook approves).
            const gateReason = cutoverReason(issue, (ref) => byRef.get(ref));
            if (gateReason && !(await this.confirmCutover(issue, gateReason))) {
                this.deps.logger.warn(`Issue #${issue.number} held at cutover gate (${gateReason}); ` +
                    `awaiting confirmation. Wire a confirmCutover hook to approve, or ` +
                    `re-run after the upstream is live.`);
                continue;
            }
            // A mode-node (deploy/publish/gate) runs a configured command instead of
            // a Claude session — no worktree, no prompt, no model/effort. Route it to
            // the separate mode-node executor; everything below is claude-node prep.
            if (isModeNode(issue)) {
                modeNodes.push(issue);
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
        return { ready, modeNodes };
    }
    /**
     * Prepare a set of issues and run them: Claude sessions in parallel via the
     * process pool, then the wave's mode-nodes (deploy/publish/gate). Mode-nodes
     * run after the Claude work because within a wave they never depend on it —
     * dependents always land in a later wave — so ordering is free, and running
     * flow-control/deploy nodes last reads naturally.
     */
    async dispatchIssues(issues) {
        const { ready, modeNodes } = await this.prepareIssues(issues);
        await this.launchAndWait(ready);
        await this.runModeNodes(modeNodes);
    }
    /**
     * Execute mode-nodes: run each command node's `command` (exit 0 → succeeded,
     * non-zero → failed). Sequential — deploy/publish steps shouldn't race, and a
     * wave rarely holds more than one. A command-less mode-node is a manual gate;
     * reaching here means its cutover was already confirmed in `prepareIssues`
     * (an unconfirmed gate is held and never dispatched), so mark it succeeded.
     */
    async runModeNodes(modeNodes) {
        for (const issue of modeNodes) {
            if (!isCommandNode(issue)) {
                // Confirmed manual gate — a no-op checkpoint that releases dependents.
                await this.setStatus(issue, "succeeded");
                this.deps.logger.info(`Issue #${issue.number} (manual ${issue.mode} gate) confirmed`);
                continue;
            }
            await this.setStatus(issue, "running");
            this.deps.logger.step(`Running ${issue.mode} node #${issue.number}: ${issue.command}`);
            this.deps.metadataStore.update(issue.ref, {
                startedAt: new Date().toISOString(),
            });
            try {
                this.deps.runCommand(issue.command);
                this.deps.metadataStore.update(issue.ref, {
                    exitCode: 0,
                    finishedAt: new Date().toISOString(),
                });
                await this.setStatus(issue, "succeeded");
                this.deps.logger.info(`Issue #${issue.number} (${issue.mode}) succeeded`);
            }
            catch (err) {
                this.deps.metadataStore.update(issue.ref, {
                    exitCode: 1,
                    finishedAt: new Date().toISOString(),
                });
                await this.setStatus(issue, "failed");
                this.deps.logger.error(`Issue #${issue.number} (${issue.mode}) failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    /**
     * Ask the `confirmCutover` hook whether a gated issue may be released. Absent
     * hook → not confirmed (hold), the conservative default for a cross-repo run.
     * A throwing hook is also treated as "not confirmed".
     */
    async confirmCutover(issue, reason) {
        const hook = this.config.hooks.confirmCutover;
        if (!hook)
            return false;
        try {
            return await hook(issue, reason);
        }
        catch (err) {
            this.deps.logger.warn(`Issue #${issue.number}: confirmCutover hook error: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
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
        const logFile = `${this.config.configDir}/logs/issue-${encodeRefForFilename(issue.ref)}.log`;
        try {
            const logContent = this.deps.readFile(logFile);
            const pr = extractPrUrl(logContent);
            if (pr) {
                this.deps.metadataStore.update(issue.ref, {
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
            const logFile = `${this.config.configDir}/logs/issue-${encodeRefForFilename(issue.ref)}.log`;
            const tools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
            const args = [
                "-p",
                prompt,
                // Per-issue model/effort (+ any --add-dir) come first so a config's
                // generic getClaudeArgs (below) can still override via last-wins.
                ...perIssueSpawnArgs(issue, this.config),
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
            this.deps.metadataStore.update(issue.ref, { startedAt: launchTime });
            const stderrFile = `${this.config.configDir}/logs/issue-${encodeRefForFilename(issue.ref)}.stderr.log`;
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
                this.deps.metadataStore.update(issue.ref, {
                    exitCode,
                    finishedAt: finishTime,
                });
                // Extract PR URL from log file
                try {
                    const logContent = this.deps.readFile(logFile);
                    const pr = extractPrUrl(logContent);
                    if (pr) {
                        this.deps.metadataStore.update(issue.ref, {
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
                        this.deps.metadataStore.update(issue.ref, {
                            exitCode: retryExitCode,
                            finishedAt: new Date().toISOString(),
                        });
                        try {
                            const logContent = this.deps.readFile(logFile);
                            const pr = extractPrUrl(logContent);
                            if (pr) {
                                this.deps.metadataStore.update(issue.ref, {
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
            // Escalate effort one tier per attempt (capped at max), keeping the model
            // (the Haiku guardrail may still promote a weak model to Sonnet).
            const retryArgs = [
                "-p", retryPrompt,
                ...perIssueSpawnArgs(issue, this.config, attempt),
                "--allowedTools", tools.join(","),
                ...this.config.hooks.getClaudeArgs(issue),
                "--output-format", "stream-json",
                "--verbose",
            ];
            const retryHandle = this.deps.processRunner.spawn("claude", retryArgs, { cwd: worktreePath, logFile, stderrFile });
            const retryExitCode = await retryHandle.exitCode;
            this.deps.metadataStore.update(issue.ref, {
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
        if (mergeResults.get(issue.ref) !== "merged")
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