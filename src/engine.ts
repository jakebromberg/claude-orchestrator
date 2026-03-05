import { ProcessPool } from "./process-pool.js";
import { StallMonitor } from "./stall-monitor.js";
import { extractPrUrl } from "./pr-tracker.js";
import { mergePrs } from "./merge.js";
import { gatherUpstreamContext } from "./upstream-context.js";
import type { MergeResult } from "./merge.js";
import type {
  Issue,
  OrchestratorConfig,
  RunOptions,
  Deps,
  Status,
  MergePolicy,
  ProcessHandle,
  Logger,
} from "./types.js";

const STALL_CHECK_INTERVAL_MS = 10_000;

const DEFAULT_ALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "Task",
];

export class Orchestrator {
  private config: OrchestratorConfig;
  private deps: Deps;
  private maxParallel: number;
  private mergePolicy: MergePolicy;

  constructor(config: OrchestratorConfig, deps: Deps, options?: RunOptions) {
    this.config = config;
    this.deps = deps;
    this.maxParallel = options?.maxParallel ?? 4;
    this.mergePolicy = options?.mergePolicy ?? "none";
  }

  checkPrerequisites(): void {
    if (!this.deps.commandExists("claude")) {
      throw new Error("claude CLI not found. Install Claude Code first.");
    }
    if (!this.deps.commandExists("gh")) {
      throw new Error("gh CLI not found. Install: brew install gh");
    }
  }

  resetStaleStatuses(): void {
    for (const issue of this.config.issues) {
      if (this.deps.statusStore.get(issue.number) === "running") {
        this.deps.logger.warn(
          `Issue #${issue.number} has stale 'running' status, resetting to pending`,
        );
        this.deps.statusStore.set(issue.number, "pending");
      }
    }
  }

  handleInterrupt(): void {
    for (const issue of this.config.issues) {
      if (this.deps.statusStore.get(issue.number) === "running") {
        this.deps.statusStore.set(issue.number, "interrupted");
      }
    }
    this.config.hooks.printSummary(
      this.config.issues,
      (n) => this.deps.statusStore.get(n),
    );
  }

  async runWave(wave: number): Promise<void> {
    this.deps.logger.header(`Running Wave ${wave}`);

    const waveIssues = this.config.issues.filter((i) => i.wave === wave);
    const ready = await this.prepareIssues(waveIssues);
    await this.launchAndWait(ready);
  }

  async runAllWaves(): Promise<void> {
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

  async runSpecific(issueNumbers: number[]): Promise<void> {
    this.deps.logger.header(`Running Specific Issues: ${issueNumbers.join(", ")}`);

    const issues: Issue[] = [];
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

  async retryFailed(): Promise<void> {
    this.deps.logger.header("Retrying Failed Issues");

    const retryable: Issue[] = [];
    for (const issue of this.config.issues) {
      const status = this.deps.statusStore.get(issue.number);
      if (this.config.hooks.isRetryableStatus(status)) {
        this.deps.statusStore.set(issue.number, "pending");
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

  async cleanup(): Promise<void> {
    this.deps.logger.header("Cleaning Up");
    for (const issue of this.config.issues) {
      await this.config.hooks.removeWorktree(issue);
    }
    this.deps.logger.info("Cleanup complete");
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async prepareIssues(
    issues: Issue[],
  ): Promise<Array<{ issue: Issue; prompt: string; sessionId: string }>> {
    const ready: Array<{ issue: Issue; prompt: string; sessionId: string }> = [];

    for (const issue of issues) {
      // Skip already succeeded
      const currentStatus = this.deps.statusStore.get(issue.number);
      if (currentStatus === "succeeded") {
        this.deps.logger.info(
          `Issue #${issue.number} already succeeded, skipping`,
        );
        this.refreshMetadata(issue);
        continue;
      }

      // Let the wrapper skip issues
      const skipResult = this.config.hooks.shouldSkipIssue(issue);
      if (skipResult.skip) {
        continue;
      }

      // Check dependencies
      if (!this.checkDeps(issue)) {
        continue;
      }

      // Set up worktree
      try {
        await this.config.hooks.setUpWorktree(issue);
      } catch (err) {
        this.deps.logger.error(
          `Issue #${issue.number}: failed to set up worktree`,
        );
        this.deps.statusStore.set(issue.number, "failed");
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

  private checkDeps(issue: Issue): boolean {
    for (const depNum of issue.deps) {
      const depStatus = this.deps.statusStore.get(depNum);
      if (depStatus !== "succeeded") {
        this.deps.logger.warn(
          `Issue #${issue.number} skipped: dependency #${depNum} has status '${depStatus}'`,
        );
        this.deps.statusStore.set(issue.number, "skipped");
        return false;
      }
    }
    return true;
  }

  private refreshMetadata(issue: Issue): void {
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
    } catch {
      // Log file may not exist — this is fine, just skip
    }
  }

  private async launchAndWait(
    ready: Array<{ issue: Issue; prompt: string; sessionId: string }>,
  ): Promise<void> {
    const pool = new ProcessPool(this.maxParallel);
    let fallbackTriggered = false;
    const postCheckPromises: Promise<void>[] = [];

    for (const { issue, prompt, sessionId } of ready) {
      await pool.waitForSlot();

      this.deps.statusStore.set(issue.number, "running");
      this.deps.logger.step(
        `Launching Claude session for issue #${issue.number}: ${issue.description}`,
      );

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
        "--session-id",
        sessionId,
        "--verbose",
      ];

      const launchTime = new Date().toISOString();
      this.deps.metadataStore.update(issue.number, { startedAt: launchTime });

      const stderrFile = `${this.config.configDir}/logs/issue-${issue.number}.stderr.log`;

      const handle: ProcessHandle = this.deps.processRunner.spawn(
        "claude",
        args,
        { cwd: worktreePath, logFile, stderrFile },
      );
      handle.issueNumber = issue.number;

      let monitor: StallMonitor | null = null;
      const effectiveStallTimeout = issue.stallTimeout ?? this.config.stallTimeout;
      if (effectiveStallTimeout > 0) {
        monitor = new StallMonitor({
          stallTimeout: effectiveStallTimeout * 1000,
          checkInterval: STALL_CHECK_INTERVAL_MS,
          getLogSize: () => this.deps.getLogFileSize(logFile),
          onStall: () => {
            this.deps.logger.warn(
              `Issue #${issue.number} stalled (no output for ${effectiveStallTimeout}s), killing process`,
            );
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
            this.deps.logger.info(
              `Issue #${issue.number} created PR: ${pr.url}`,
            );
          }
        } catch {
          // Log file may not exist if process was killed early
        }

        if (exitCode !== 0) {
          if (this.isZeroByteLog(logFile)) {
            // 0-byte stall — retry once
            try {
              const stderr = this.deps.readFile(stderrFile);
              if (stderr.length > 0) {
                this.deps.logger.warn(
                  `Issue #${issue.number} stderr before retry:\n${stderr}`,
                );
              }
            } catch {}

            this.deps.logger.warn(
              `Issue #${issue.number} produced 0-byte log (exit ${exitCode}), retrying once...`,
            );

            this.deps.truncateFile(logFile);
            this.deps.truncateFile(stderrFile);

            const retryHandle = this.deps.processRunner.spawn(
              "claude", args,
              { cwd: worktreePath, logFile, stderrFile },
            );
            retryHandle.issueNumber = issue.number;

            let retryMonitor: StallMonitor | null = null;
            const retryStallTimeout = issue.stallTimeout ?? this.config.stallTimeout;
            if (retryStallTimeout > 0) {
              retryMonitor = new StallMonitor({
                stallTimeout: retryStallTimeout * 1000,
                checkInterval: STALL_CHECK_INTERVAL_MS,
                getLogSize: () => this.deps.getLogFileSize(logFile),
                onStall: () => {
                  this.deps.logger.warn(
                    `Issue #${issue.number} retry stalled (no output for ${retryStallTimeout}s), killing process`,
                  );
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
                this.deps.logger.info(
                  `Issue #${issue.number} created PR: ${pr.url}`,
                );
              }
            } catch {}

            if (retryExitCode !== 0) {
              if (this.isZeroByteLog(logFile) && !fallbackTriggered) {
                fallbackTriggered = true;
                pool.setMaxParallel(1);
                this.deps.logger.warn(
                  `Issue #${issue.number}: 0-byte failure persisted after retry, falling back to sequential execution`,
                );
              }
              this.deps.statusStore.set(issue.number, "failed");
              this.deps.logger.error(
                `Issue #${issue.number} retry failed (exit code ${retryExitCode}). Log: ${logFile}`,
              );
              return;
            }

            if (!(await this.runPostSessionCheck(issue, worktreePath))) return;

            this.deps.statusStore.set(issue.number, "succeeded");
            this.deps.logger.info(
              `Issue #${issue.number} succeeded (after retry)`,
            );
            return;
          }

          this.deps.statusStore.set(issue.number, "failed");
          this.deps.logger.error(
            `Issue #${issue.number} failed (exit code ${exitCode}). Log: ${logFile}`,
          );
          return;
        }

        if (!(await this.runPostSessionCheck(issue, worktreePath))) return;

        this.deps.statusStore.set(issue.number, "succeeded");
        this.deps.logger.info(`Issue #${issue.number} succeeded`);
      });
      postCheckPromises.push(postCheck);

      pool.add(handle);
    }

    await pool.waitAll();
    await Promise.all(postCheckPromises);
  }

  private isZeroByteLog(logFile: string): boolean {
    return this.deps.getLogFileSize(logFile) === 0;
  }

  private async runPostSessionCheck(
    issue: Issue,
    worktreePath: string,
  ): Promise<boolean> {
    if (!this.config.hooks.postSessionCheck) return true;

    try {
      const result = await this.config.hooks.postSessionCheck(
        issue, worktreePath,
      );
      if (!result.passed) {
        this.deps.statusStore.set(issue.number, "failed");
        this.deps.logger.error(
          `Issue #${issue.number} post-check failed: ${result.summary ?? "unknown reason"}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.deps.statusStore.set(issue.number, "failed");
      this.deps.logger.error(
        `Issue #${issue.number} post-check threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}

/**
 * Clean up worktrees and remote branches for issues that were successfully merged.
 * Failures are non-fatal (logged as warnings) so one failed cleanup doesn't block others.
 */
export async function cleanUpMergedIssues(
  issues: Issue[],
  mergeResults: Map<number, MergeResult>,
  deps: {
    removeWorktree: (issue: Issue) => Promise<void>;
    runCommand: (cmd: string) => string;
    logger: Logger;
    getBranchName: (issue: Issue) => string;
  },
): Promise<void> {
  for (const issue of issues) {
    if (mergeResults.get(issue.number) !== "merged") continue;

    try {
      await deps.removeWorktree(issue);
      deps.logger.info(`#${issue.number}: removed worktree`);
    } catch (err) {
      deps.logger.warn(
        `#${issue.number}: worktree removal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const branchName = deps.getBranchName(issue);
    try {
      deps.runCommand(`git push origin --delete ${branchName}`);
      deps.logger.info(`#${issue.number}: deleted remote branch ${branchName}`);
    } catch (err) {
      deps.logger.warn(
        `#${issue.number}: remote branch deletion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
