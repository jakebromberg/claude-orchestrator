import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue, OrchestratorHooks, PostCheckResult, PostSessionCheckContext, Status } from "./types.js";
import type { YamlConfig } from "./yaml-types.js";
import { createPrintSummary, type SummaryColumn } from "./summary.js";
import { interpolate } from "./interpolate.js";
import { createLabelSyncHandler } from "./label-sync.js";
import { detectCollisions, gatherCollisionInputs } from "./collision-check.js";
import { resolveRepoSettings } from "./repo-settings.js";
import { perIssueSpawnArgs } from "./model-effort.js";
import { shellQuote } from "./shell-quote.js";
import { claudeExecOptions } from "./claude-env.js";
import { acquireLease, defaultWarn, type LeaseHandle, type LeaseOptions, type LeaseRefusal } from "./lease.js";
import { formatPostCheckStop, refusalStopReason, throttledProgress } from "./lease-messages.js";
import { weightForCommands } from "./lease-weights.js";
import { SYNC_CALL_TIMEOUT_MS, describeBoundedFailure } from "./sync-budget.js";
import { stopAtCritical } from "./memory-pressure.js";
import { groupAlive, signalGroup } from "./ps.js";

const OUTPUT_TAIL_BYTES = 64 * 1024;

/** The largest delay `setTimeout` honours; Node fires a longer one after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** How long a timed-out command's process group has between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** How often a finished command's process group is probed while a member is still alive. */
const GROUP_RECHECK_MS = 250;

/** Process groups of bounded {@link runShellAsync} commands that have not closed yet. */
const liveGroups = new Set<number>();

/**
 * Sends SIGKILL to the process group of every bounded {@link runShellAsync} command still live, synchronously. A
 * bounded command runs in its own group, so the terminal's Ctrl-C does not reach it; this runs on the process's `exit`
 * event, so an engine that exits (its SIGINT/SIGTERM handler ends in `process.exit`) does not leave a deploy running
 * behind it. Exit is final and the kill-after-grace timer dies with the engine, so there is no grace: a member that
 * traps SIGTERM (including one a timeout already sent SIGTERM to) must not outlive the engine. ESRCH is ignored.
 */
export function stopLiveCommandGroups(): void {
  for (const pgid of liveGroups) {
    try {
      signalGroup(pgid, "SIGKILL");
    } catch {
      // Best effort at exit: nothing to do about another error.
    }
  }
}

/**
 * The last `max` bytes of `buf`, moved forward past any UTF-8 continuation
 * bytes so that the tail never starts in the middle of a character.
 */
function utf8Tail(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let start = buf.length - max;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
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
 * grandchild may still hold open. If the engine exits first, any group still live
 * gets SIGKILL at once ({@link stopLiveCommandGroups}). Without a bound the shell stays in
 * the engine's group, as before.
 */
export function runShellAsync(
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
  onSpawn?: (pid: number) => void,
  timeoutMs?: number,
  killGraceMs = KILL_GRACE_MS,
): Promise<string> {
  const bounded = timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: bounded,
    });
    // Set by this call's settleGroup when it drops the pgid. The id may then be reused by another bounded command, so
    // this call never signals it again, whatever liveGroups holds now.
    let dropped = false;
    const signalChildGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || dropped) return;
      try {
        signalGroup(child.pid, signal);
      } catch {
        // signalGroup returns false for a vanished group; this catches any other error (such as EPERM), which is ignored.
      }
    };
    if (bounded && child.pid !== undefined) {
      if (!process.listeners("exit").includes(stopLiveCommandGroups)) {
        process.on("exit", stopLiveCommandGroups);
      }
      liveGroups.add(child.pid);
    }
    let graceTimer: NodeJS.Timeout | undefined;
    let tail: Buffer = Buffer.alloc(0);
    const collect = (chunk: Buffer) => {
      tail = utf8Tail(Buffer.concat([tail, chunk]), OUTPUT_TAIL_BYTES);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let onSpawnFailure: { error: unknown } | undefined;
    const timer = bounded
      ? setTimeout(() => {
          signalChildGroup("SIGTERM");
          graceTimer = setTimeout(() => signalChildGroup("SIGKILL"), killGraceMs);
          reject(new Error(`Command timed out after ${timeoutMs} ms\n${tail.toString("utf-8")}`));
        }, timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // A group stays in the live set, with its pending grace SIGKILL, until no member is left: a member that traps
    // TERM and no longer holds the pipes outlives both 'exit' and 'close'. 'close' also waits for every holder of the
    // pipes, so a daemon that escaped the group would leave the pgid here after the group is gone and the id may be
    // reused. So at 'exit' and 'close' probe the group, and while a member lives re-check every RECHECK_MS on an
    // unref'd timer (it never keeps the engine alive, and ends the moment the group is empty).
    let recheck: NodeJS.Timeout | undefined;
    const settleGroup = () => {
      clearTimeout(recheck);
      // Once this call dropped its group, a later 'close' must not probe or poll the pgid: another command may own it now.
      if (child.pid === undefined || dropped) return;
      if (groupAlive(child.pid)) {
        recheck = setTimeout(settleGroup, GROUP_RECHECK_MS);
        recheck.unref();
        return;
      }
      clearTimeout(graceTimer);
      dropped = true;
      liveGroups.delete(child.pid);
    };
    child.on("exit", settleGroup);
    child.on("error", settleGroup);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settleGroup();
      if (onSpawnFailure) return reject(onSpawnFailure.error);
      const output = tail.toString("utf-8");
      if (code === 0) return resolve(output);
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(Object.assign(new Error(`Command failed with ${how}\n${output}`), code === null ? {} : { status: code }));
    });
    if (child.pid !== undefined && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch (error) {
        onSpawnFailure = { error };
        child.kill();
      }
    }
  });
}

/**
 * One lease slot for a whole post-session check, labelled with the issue so the holder file does not show its first
 * command. Waits with no cap; at `critical` it ends in a refusal once no live holder and no engine session is left to
 * relieve the pressure. The engine never inherits a holder id, so `inheritedHolderId` is dropped. The slot covers the
 * whole command loop, so its weight is the largest any command resolves to, and absent when none matches.
 */
function acquireCheckLease(
  lease: LeaseOptions,
  issue: Issue,
  cwd: string,
  commands: string[],
  runningSessions: () => number = () => 0,
): Promise<LeaseHandle | LeaseRefusal> {
  const warn = lease.warn ?? defaultWarn;
  // The table comes from the handed lease's own directory, so holders and weight rules can never disagree about where the lease lives.
  const weight = weightForCommands(commands, cwd, { ...process.env, CO_LEASE_DIR: lease.dir }, warn) ?? 0;
  return acquireLease(
    { ...lease, inheritedHolderId: undefined },
    { command: commands[0] ?? "", label: `post-check ${issue.ref}`, cwd, ...(weight > 0 && { weight }) },
    {
      onWait: throttledProgress((s) => (lease.warn ?? defaultWarn)(
        `Issue #${issue.number} post-check waiting for a lease slot (${s.level}, ${s.live.length}/${s.capacity} slots held)`,
      )),
      stopWhen: (s) => stopAtCritical(s.level, s.live.length + runningSessions()),
    },
  );
}

/** I/O dependencies injectable for testing. */
export interface DeriveHooksDeps {
  readFile?: (path: string) => string;
  /**
   * Runs both the `postSessionCheck` commands and the `onMergeConflict`
   * resolver. Their defaults differ: the check inherits the full environment
   * (it runs the project's own commands, which may need an API key), while the
   * resolver launches `claude` under `claudeExecOptions()`.
   *
   * Overriding this collapses that distinction — an injected runner is used
   * verbatim for both, so the merge-conflict session will authenticate with
   * whatever environment the override passes. Apply `claudeSessionEnv()`
   * yourself in the override if you want sessions on the Claude Code login.
   *
   * May return synchronously or a Promise; both callers `await` the result,
   * and a throw or rejection counts as failure. The check's default is
   * {@link runShellAsync}, which keeps the event loop free; `env` overrides
   * the child's environment and `onSpawn` receives the child's PID (the
   * default runner honors both).
   */
  runCommand?: (
    cmd: string,
    cwd: string,
    env?: Record<string, string>,
    onSpawn?: (pid: number) => void,
  ) => string | Promise<string>;
  /**
   * Used by collision detection to run git commands with an argument array
   * (avoids shell quoting entirely). Defaults to `execFileSync` with a
   * {@link SYNC_CALL_TIMEOUT_MS} bound per call.
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

    getBaseBranch(issue: Issue): string {
      // This issue's repo's own default branch (iOS `master`, others `main`),
      // resolved the same way postSessionCheck/onMergeConflict resolve it — so
      // the merge step rebases a cross-repo PR onto the correct ref.
      return resolveRepoSettings(yaml, issue.repo ?? yaml.defaultRepo).baseBranch;
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
      ctx?: PostSessionCheckContext,
    ): Promise<PostCheckResult> => {
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
      let stopped: LeaseRefusal | undefined;
      if (cmdConfig) {
        const execDir = cmdConfig.cwd
          ? path.join(worktreePath, cmdConfig.cwd)
          : worktreePath;
        let slot: LeaseHandle | undefined;
        if (ctx?.lease) {
          const got = await acquireCheckLease(ctx.lease, issue, execDir, cmdConfig.commands, ctx.runningSessions);
          if ("refused" in got) stopped = got;
          else slot = got;
        }
        try {
          for (const cmd of stopped ? [] : cmdConfig.commands) {
            try {
              await (slot ? run(cmd, execDir, slot.childEnv(), slot.setChildPid) : run(cmd, execDir));
            } catch (err) {
              return {
                passed: false,
                summary: `Command failed: ${cmd}\n${(err as Error).message}`,
                output: (err as Error).message,
              };
            }
          }
        } finally {
          slot?.release();
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
          deps.runGitCommand ?? ((file, args) => execFileSync(file, args, { encoding: "utf-8", timeout: SYNC_CALL_TIMEOUT_MS }));

        const collisionInput = gatherCollisionInputs({
          runCommand: gitRun,
          existsSync: exists,
          currentWorktree: worktreePath,
          peers,
          entries: sequentialEntries,
          baseBranch,
          onFetchError: (branch, err) => {
            // git's error spans several lines; its stderr already reached the engine's, so keep the warning to one.
            (ctx?.lease?.warn ?? console.warn)(
              `[collision-check] fetch of origin/${branch} in ${worktreePath} failed (${describeBoundedFailure(err, SYNC_CALL_TIMEOUT_MS)}); scanned the locally known origin/${branch}, which may be stale`,
            );
          },
          onPeerError: (slug, err) => {
            (ctx?.lease?.warn ?? console.warn)(
              `[collision-check] skipping peer ${slug}: ${describeBoundedFailure(err, SYNC_CALL_TIMEOUT_MS)}`,
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
      ?? ((cmd: string, cwd: string) => execSync(cmd, claudeExecOptions({ cwd })));

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
        await resolveRunCommand(cmd, worktreePath);
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
            execSync(cmd, { stdio: "pipe", encoding: "utf-8", timeout: SYNC_CALL_TIMEOUT_MS }),
          logger: { info() {}, warn(msg: string) { console.warn(msg); }, error() {}, step() {}, header() {} },
        },
      );
    }
  }

  return hooks;
}
