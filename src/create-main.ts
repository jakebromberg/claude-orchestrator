import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./cli.js";
import { Orchestrator, cleanUpMergedIssues } from "./engine.js";
import { FileStatusStore, FileMetadataStore } from "./status.js";
import { consoleLogger } from "./log.js";
import { randomUUID } from "node:crypto";
import type { Deps, OrchestratorConfig, Status } from "./types.js";
import { writeRunRecord } from "./run-history.js";
import { createRealProcessRunner } from "./real-process-runner.js";
import { startWatch } from "./watch.js";
import { mergePrs } from "./merge.js";
import { generateReport, formatReport } from "./report.js";
import { postRunSummaryComments } from "./issue-comments.js";

export type ConfigFactory =
  | ((projectRoot: string) => OrchestratorConfig)
  | ((projectRoot: string) => Promise<OrchestratorConfig>);

export interface MainOptions {
  configs: Record<string, ConfigFactory>;
  argv?: string[];
  projectRoot?: string;
}

function createRealDeps(config: OrchestratorConfig): Deps {
  return {
    statusStore: new FileStatusStore(config.configDir),
    metadataStore: new FileMetadataStore(config.configDir),
    processRunner: createRealProcessRunner(),
    logger: consoleLogger,
    generateSessionId: () => randomUUID(),
    commandExists: (cmd: string) => {
      try {
        execSync(`command -v ${cmd}`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    },
    getLogFileSize: (logFile: string) => {
      try {
        return fs.statSync(logFile).size;
      } catch {
        return 0;
      }
    },
    readFile: (filePath: string) => fs.readFileSync(filePath, "utf-8"),
    runCommand: (cmd: string) => execSync(cmd, { stdio: "pipe", encoding: "utf-8" }),
    truncateFile: (filePath: string) => {
      try { fs.truncateSync(filePath, 0); } catch {}
    },
  };
}

export async function createMain(options: MainOptions): Promise<void> {
  const { configs } = options;
  const argv = options.argv ?? process.argv.slice(2);
  const projectRoot = options.projectRoot ?? process.cwd();

  const [configName, ...restArgv] = argv;

  if (!configName || !configs[configName]) {
    console.error(
      `Usage: <script> <config> [options]\nAvailable configs: ${Object.keys(configs).join(", ")}`,
    );
    process.exit(1);
  }

  // The consumer's entry point (for --detach re-spawn)
  const scriptPath = process.argv[1];

  const config = await Promise.resolve(configs[configName](projectRoot));
  const args = parseArgs(restArgv);
  const deps = createRealDeps(config);
  const orchestrator = new Orchestrator(config, deps, {
    maxParallel: args.maxParallel,
    mergePolicy: args.mergeAfterWave ? "after-wave" : "none",
  });

  // Ignore SIGHUP so detached processes survive terminal close
  process.on("SIGHUP", () => {});

  // Handle decompose
  if (args.mode === "decompose") {
    const { decompose } = await import("./decompose.js");

    let description = "";

    // Read from file if provided
    if (args.decomposeFile) {
      description = fs.readFileSync(args.decomposeFile, "utf-8");
    }

    // Read from stdin if no file
    if (!description && !args.decomposeIssue) {
      description = fs.readFileSync(0, "utf-8");
    }

    const result = await decompose({
      featureDescription: description || "See GitHub issue",
      featureFile: args.decomposeFile,
      issueNumber: args.decomposeIssue,
      repo: args.decomposeRepo,
    }, {
      runCommand: (cmd, options) => execSync(cmd, {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        ...(options?.input ? { input: options.input } : {}),
      }),
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      logger: consoleLogger,
    });

    if (args.createIssues && args.decomposeRepo) {
      consoleLogger.step("Creating GitHub issues...");
      const slugToIssueNumber = new Map<string, number>();

      for (const issue of result.issues) {
        const depRefs = issue.dependsOn
          .map((d) => slugToIssueNumber.get(d))
          .filter((n): n is number => n !== undefined)
          .map((n) => `#${n}`)
          .join(", ");

        const body = issue.description + (depRefs ? `\n\nDepends on: ${depRefs}` : "");
        const output = execSync(
          `gh issue create --repo ${args.decomposeRepo} --title "${issue.slug}" --body-file -`,
          { input: body, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const match = output.match(/\/issues\/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          slugToIssueNumber.set(issue.slug, num);
          consoleLogger.info(`Created #${num}: ${issue.slug}`);
        }
      }

      // Print YAML with real issue numbers
      const lines: string[] = ["issues:"];
      for (const issue of result.issues) {
        const num = slugToIssueNumber.get(issue.slug) ?? "TBD";
        const deps = issue.dependsOn
          .map((d) => slugToIssueNumber.get(d) ?? "TBD")
          .join(", ");
        lines.push(`  - number: ${num}`);
        lines.push(`    slug: ${issue.slug}`);
        lines.push(`    dependsOn: [${deps}]`);
        lines.push(`    description: "${issue.description.replace(/"/g, '\\"')}"`);
      }
      console.log("\n" + lines.join("\n"));
    } else {
      console.log(result.yamlFragment);
    }

    process.exit(0);
  }

  // Handle help
  if (args.mode === "help") {
    config.hooks.showHelp();
    process.exit(0);
  }

  // Handle status
  if (args.mode === "status") {
    config.hooks.printSummary(config.issues, (n) => deps.statusStore.get(n));
    process.exit(0);
  }

  // Handle watch
  if (args.mode === "watch") {
    const handle = startWatch({
      config,
      statusStore: deps.statusStore,
      write: process.stdout.write.bind(process.stdout),
    });
    process.on("SIGINT", () => {
      handle.stop();
      process.exit(0);
    });
    return;
  }

  // Handle merge
  if (args.mode === "merge") {
    deps.logger.header(`${config.name} — Merge Mode`);
    const results = mergePrs(config.issues, {
      getStatus: (n) => deps.statusStore.get(n),
      getMetadata: (n) => deps.metadataStore.get(n),
      runCommand: (cmd) => deps.runCommand(cmd),
      logger: deps.logger,
      getWorktreePath: (issue) => config.hooks.getWorktreePath(issue),
    }, { admin: true });

    await cleanUpMergedIssues(config.issues, results, {
      removeWorktree: (issue) => config.hooks.removeWorktree(issue),
      runCommand: (cmd) => deps.runCommand(cmd),
      logger: deps.logger,
      getBranchName: (issue) => config.hooks.getBranchName(issue),
    });

    const merged = [...results.values()].filter((r) => r === "merged").length;
    const failed = [...results.values()].filter((r) => r === "failed").length;
    const rebaseFailed = [...results.values()].filter((r) => r === "rebase-failed").length;
    const skipped = [...results.values()].filter((r) => r === "skipped").length;
    console.log("");
    deps.logger.info(`Merge complete: ${merged} merged, ${failed} failed, ${rebaseFailed} rebase-failed, ${skipped} skipped`);
    process.exit(failed > 0 ? 1 : 0);
  }

  // Handle cleanup
  if (args.mode === "cleanup") {
    await orchestrator.cleanup();
    process.exit(0);
  }

  // Handle tail (reattach to detached run)
  if (args.mode === "tail") {
    const pidFile = path.join(config.configDir, "orchestrator.pid");
    if (!fs.existsSync(pidFile)) {
      console.error("No detached run found (no PID file)");
      process.exit(1);
    }
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
    } catch {
      console.error(`Process ${pid} is not running`);
      fs.unlinkSync(pidFile);
      process.exit(1);
    }
    const logFile = path.join(config.configDir, "logs", "orchestrator.log");
    const tail = spawn("tail", ["-F", logFile], { stdio: "inherit" });
    tail.on("close", () => process.exit(0));
    process.on("SIGINT", () => {
      tail.kill();
      process.exit(0);
    });
    return;
  }

  // Validate --detach compatibility
  if (args.detach && ["tail", "help", "status", "watch", "cleanup"].includes(args.mode)) {
    console.error(`--detach cannot be combined with --${args.mode}`);
    process.exit(1);
  }

  // Ensure directories exist
  fs.mkdirSync(path.join(config.configDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, "status"), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, "metadata"), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, "reports"), { recursive: true });
  fs.mkdirSync(config.worktreeDir, { recursive: true });

  // Handle --detach: fork into background process
  if (args.detach) {
    const pidFile = path.join(config.configDir, "orchestrator.pid");

    // Guard against double-detach
    if (fs.existsSync(pidFile)) {
      const existingPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      try {
        process.kill(existingPid, 0);
        console.error(`Detached orchestrator already running (PID ${existingPid})`);
        process.exit(1);
      } catch {
        // Stale PID file, clean it up and proceed
        fs.unlinkSync(pidFile);
      }
    }

    const logFile = path.join(config.configDir, "logs", "orchestrator.log");
    const logFd = fs.openSync(logFile, "a");

    try {
      // Strip Claude Code env vars so child sessions don't think they're nested
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const childArgv = restArgv.filter((a) => a !== "--detach");
      const child = spawn(
        process.execPath,
        [scriptPath, configName, ...childArgv],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          cwd: projectRoot,
          env,
        },
      );

      if (!child.pid) {
        console.error("Failed to spawn detached process");
        process.exit(1);
      }
      child.unref();

      fs.writeFileSync(pidFile, String(child.pid));
      console.log(`Detached orchestrator (PID ${child.pid})`);
      console.log(`Log: ${logFile}`);
      console.log(`Reattach: <script> ${configName} --tail`);
    } finally {
      fs.closeSync(logFd);
    }
    process.exit(0);
  }

  // Reset stale statuses and check prerequisites
  orchestrator.resetStaleStatuses();
  orchestrator.checkPrerequisites();

  // Run hooks
  await config.hooks.preflightCheck();
  await config.hooks.preRunSetup();

  deps.logger.header(config.name);
  console.log("");
  deps.logger.info(`Max parallel sessions: ${args.maxParallel}`);
  deps.logger.info(`Worktree directory: ${config.worktreeDir}`);
  deps.logger.info(`Log directory: ${config.configDir}/logs`);
  console.log("");

  // Capture start time for run record (before dispatch and signal handler)
  const startedAt = new Date();

  function collectAndWriteRunRecord(): void {
    const finishedAt = new Date();
    const durationSeconds =
      Math.round((finishedAt.getTime() - startedAt.getTime()) / 10) / 100;

    const statuses: Record<number, Status> = {};
    for (const issue of config.issues) {
      statuses[issue.number] = deps.statusStore.get(issue.number);
    }

    const id = startedAt.toISOString().replace(/:/g, "-");
    writeRunRecord(config.configDir, {
      id,
      configName: config.name,
      mode: args.mode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      maxParallel: args.maxParallel,
      ...(args.wave !== undefined ? { wave: args.wave } : {}),
      ...(args.mode === "run-specific" ? { targetIssues: args.issues } : {}),
      statuses,
    });
  }

  // Set up signal handler (writes run record before exiting)
  const handleSignal = () => {
    orchestrator.handleInterrupt();
    collectAndWriteRunRecord();
    process.exit(130);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Dispatch
  try {
    if (args.mode === "retry-failed") {
      await orchestrator.retryFailed();
    } else if (args.mode === "run-specific") {
      await orchestrator.runSpecific(args.issues);
    } else if (args.wave !== undefined) {
      await orchestrator.runWave(args.wave);
    } else {
      await orchestrator.runAllWaves();
    }
  } finally {
    collectAndWriteRunRecord();

    // Send macOS notification (in finally so it fires even on crash)
    if (args.notify && process.platform === "darwin") {
      const succeeded = config.issues.filter(
        (i) => deps.statusStore.get(i.number) === "succeeded",
      ).length;
      const failed = config.issues.filter(
        (i) => deps.statusStore.get(i.number) === "failed",
      ).length;
      const message = `${succeeded} succeeded, ${failed} failed`;
      const title = config.name.replace(/"/g, '\\"');
      try {
        execSync(
          `osascript -e 'display notification "${message}" with title "${title}"'`,
        );
      } catch {
        // Non-fatal: osascript can fail in SSH sessions
      }
    }
  }

  config.hooks.printSummary(config.issues, (n) => deps.statusStore.get(n));

  // Write post-run report
  const finishedAt = new Date();
  const report = generateReport(
    config.name,
    config.issues,
    (n) => deps.statusStore.get(n),
    (n) => deps.metadataStore.get(n),
    startedAt,
    finishedAt,
  );

  const reportId = startedAt.toISOString().replace(/:/g, "-");
  const jsonPath = path.join(config.configDir, "reports", `${reportId}.json`);
  const mdPath = path.join(config.configDir, "reports", `${reportId}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, formatReport(report));
  deps.logger.info(`Report written to ${mdPath}`);

  // Post run summary comments on GitHub issues
  if (config.issueComments?.enabled) {
    deps.logger.step("Posting run summary comments on GitHub issues...");
    postRunSummaryComments(config.issues, {
      repo: config.issueComments.repo,
      runId: reportId,
      configName: config.name,
    }, {
      runCommand: (cmd, options) => execSync(cmd, {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        ...(options?.input ? { input: options.input } : {}),
      }),
      getStatus: (n) => deps.statusStore.get(n),
      getMetadata: (n) => deps.metadataStore.get(n),
      logger: deps.logger,
    });
  }

  // Clean up PID file if it matches our process
  const pidFile = path.join(config.configDir, "orchestrator.pid");
  try {
    const storedPid = fs.readFileSync(pidFile, "utf-8").trim();
    if (storedPid === String(process.pid)) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // PID file may not exist (non-detached run)
  }
}
