#!/usr/bin/env node
/**
 * Runs a command under the machine-wide heavy-command lease, or reports who
 * holds it:
 *
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] -- <cmd> [args...]
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] --shell '<command line>'
 *   claude-orchestrator-lease status
 *   claude-orchestrator-lease hook [--print-settings-entry]
 *
 * The slot is held for exactly as long as the command lives, and the command's
 * exit code is passed through. Exit 75 means no slot within the wait cap
 * (rerun); exit 78 means the lease is misconfigured (a relative `CO_LEASE_DIR`).
 *
 * Pure helpers (`parseLeaseArgs`, `runLeased`, `runStatus`) take every external
 * interaction through `LeaseCliDeps`; the file's bottom wires real I/O.
 */

import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import type { PressureSampler } from "./memory-pressure.js";
import { acquireLease, defaultLeaseOptions, leaseStatus, type LeaseOptions, type LeaseStatus } from "./lease.js";
import { formatAdmitted, formatNoSlot, seconds } from "./lease-messages.js";
import { runHook } from "./lease-hook.js";

export { formatAdmitted, formatNoSlot };

const DEFAULT_MAX_WAIT_SEC = 100;
const ANCESTOR_DEPTH = 32;
const GRACE_MS = 10_000;
const PROGRESS_MS = 60_000;
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const EX_USAGE = 64;
const EX_TEMPFAIL = 75;
const EX_CONFIG = 78;

/** Exactly one of `argv` (spawned directly) and `shell` (run under `/bin/sh -c`) is set. */
export interface RunArgs {
  kind: "run";
  maxWaitSec?: number;
  label?: string;
  argv?: string[];
  shell?: string;
}
export type LeaseArgs = RunArgs | { kind: "status" };

/** The slice of a `ChildProcess` the run loop uses. */
export interface LeaseChild {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", cb: (err: NodeJS.ErrnoException) => void): unknown;
}

export interface LeaseCliDeps {
  /** Throws on a configuration error (a relative `CO_LEASE_DIR`). */
  leaseOptions(): LeaseOptions;
  acquire: typeof acquireLease;
  leaseStatus(opts: LeaseOptions): LeaseStatus;
  /** PIDs of this process's ancestors, nearest first; `[]` when they cannot be read. */
  ancestors(): number[];
  spawn(file: string, args: string[], opts: { env: NodeJS.ProcessEnv }): LeaseChild;
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(text: string): void;
  err(line: string): void;
  /** `process` in production: `kill(pid, sig)` on its own `pid` re-raises a signal that arrives while waiting. */
  signals: { on(sig: NodeJS.Signals, fn: () => void): unknown; off(sig: NodeJS.Signals, fn: () => void): unknown;
    kill(pid: number, sig: NodeJS.Signals): unknown; pid: number };
}

function parseSeconds(text: string | undefined): number | undefined {
  const n = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseLeaseArgs(argv: string[]): LeaseArgs {
  if (argv[0] && !argv[0].startsWith("-")) {
    if (argv[0] !== "status") throw new Error(`Unknown subcommand: ${argv[0]}`);
    if (argv.length > 1) throw new Error("status takes no arguments");
    return { kind: "status" };
  }
  let maxWaitSec: number | undefined;
  let label: string | undefined;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v === "") throw new Error(`${flag} requires an argument`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i]!;
    if (arg === "--") {
      if (i + 1 >= argv.length) throw new Error("no command after --");
      return { kind: "run", maxWaitSec, label, argv: argv.slice(i + 1) };
    }
    if (arg === "--shell") {
      const shell = value(i, "--shell");
      if (i + 2 !== argv.length) throw new Error("--shell must be the last argument");
      return { kind: "run", maxWaitSec, label, shell };
    }
    if (arg === "--max-wait") {
      if (maxWaitSec !== undefined) throw new Error("--max-wait given more than once");
      maxWaitSec = parseSeconds(value(i, "--max-wait"));
      if (maxWaitSec === undefined) throw new Error("--max-wait must be a number of seconds, 0 or more");
    } else if (arg === "--label") {
      if (label !== undefined) throw new Error("--label given more than once");
      label = value(i, "--label");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  throw new Error("a command is required: -- <cmd> [args...] or --shell '<command line>'");
}

function optionsOrReport(d: LeaseCliDeps): LeaseOptions | undefined {
  try {
    return d.leaseOptions();
  } catch (err) {
    d.err(`lease: ${(err as Error).message}`);
    return undefined;
  }
}

/** The id of a live hook holder (`expiresAt` set) whose session PID is one of this CLI's ancestors; `undefined` when none or the ancestors are unreadable. */
function ancestorHookSlot(opts: LeaseOptions, d: LeaseCliDeps): string | undefined {
  try {
    const up = new Set(d.ancestors());
    return up.size === 0 ? undefined : d.leaseStatus(opts).live.find((h) => h.expiresAt !== undefined && up.has(h.pid))?.id;
  } catch {
    return undefined;
  }
}

/** Walks `ps -o ppid=` up from `process.ppid`, at most `ANCESTOR_DEPTH` levels; any failure ends the walk with what it has found (`[]` if the first call fails). */
function psAncestors(): number[] {
  const found: number[] = [];
  try {
    for (let pid = process.ppid; found.length < ANCESTOR_DEPTH && Number.isInteger(pid) && pid > 1; pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim())) {
      found.push(pid);
    }
  } catch {
    // A failed lookup means no borrow, never an error.
  }
  return found;
}

/** Prints the holders as JSON; returns the exit code. */
export function runStatus(d: LeaseCliDeps): number {
  const opts = optionsOrReport(d);
  if (!opts) return EX_CONFIG;
  const { level, capacity, live } = d.leaseStatus(opts);
  const holders = live.map((h) => ({ pid: h.pid, command: h.command, ageSec: h.ageSec, ...(h.override && { override: true }) }));
  d.out(`${JSON.stringify({ level, capacity, live: holders }, null, 2)}\n`);
  return 0;
}

/** Waits for a slot, runs the command with it held, and returns the exit code to pass through. */
export async function runLeased(args: RunArgs, d: LeaseCliDeps): Promise<number> {
  const opts = optionsOrReport(d);
  if (!opts) return EX_CONFIG;
  const envWait = d.env.CO_LEASE_MAX_WAIT || undefined;
  const fromEnv = parseSeconds(envWait);
  if (envWait !== undefined && fromEnv === undefined && args.maxWaitSec === undefined) {
    d.err(`lease: ignoring invalid CO_LEASE_MAX_WAIT=${JSON.stringify(envWait)}; using ${DEFAULT_MAX_WAIT_SEC}s`);
  }
  const maxWaitMs = (args.maxWaitSec ?? fromEnv ?? DEFAULT_MAX_WAIT_SEC) * 1000;
  const [file, fileArgs] = args.shell !== undefined ? ["/bin/sh", ["-c", args.shell]] : [args.argv![0]!, args.argv!.slice(1)];

  // Installed before acquiring: a signal's default action would otherwise kill the wrapper between the holder file's
  // write and the spawn, leaving a slot that no child holds. A handler can only run while waiting (nothing is held, so
  // the signal is re-raised to kill the wrapper as before) or once the child exists, never in between.
  let child: LeaseChild | undefined;
  let signalled: number | undefined;
  let grace: NodeJS.Timeout | undefined;
  let finish = (_code: number): void => {};
  const handlers = FORWARDED.map((sig) => {
    const forward = (): void => {
      if (child === undefined) {
        unhook();
        d.signals.kill(d.signals.pid, sig);
        return;
      }
      signalled ??= constants.signals[sig];
      child.kill(sig);
      grace ??= setTimeout(() => {
        child!.kill("SIGKILL");
        finish(128 + signalled!);
      }, GRACE_MS);
    };
    d.signals.on(sig, forward);
    return [sig, forward] as const;
  });
  const unhook = (): void => handlers.forEach(([sig, forward]) => d.signals.off(sig, forward));

  // A hook slot the session already holds is borrowed through `inheritedHolderId`, never waited for a second time.
  const hookSlot = opts.inheritedHolderId ? undefined : ancestorHookSlot(opts, d);
  let lastProgress = 0;
  const got = await d.acquire(hookSlot ? { ...opts, inheritedHolderId: hookSlot } : opts, { command: args.shell ?? args.argv!.join(" "), label: args.label, cwd: d.cwd }, {
    maxWaitMs,
    onWait: (s) => {
      if (s.waitedMs - lastProgress < PROGRESS_MS) return;
      lastProgress = s.waitedMs;
      d.err(`lease: waiting ${seconds(s.waitedMs)}s for a slot (pressure=${s.level}, ${s.live.length}/${s.capacity} live)`);
    },
  });
  if (!("leased" in got)) {
    unhook();
    d.err(formatNoSlot(got, d.leaseStatus(opts)));
    return EX_TEMPFAIL;
  }
  if (hookSlot && got.leased && got.id === hookSlot) d.err(`lease: running inside this session's hook slot (${hookSlot})`);
  else if (got.leased) d.err(formatAdmitted(got.admission));

  return new Promise<number>((resolve) => {
    let settled = false;
    finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      unhook();
      got.release({ exitCode: code });
      resolve(code);
    };
    const cannotRun = (e: NodeJS.ErrnoException): void => {
      d.err(`lease: cannot run ${file}: ${e.message}`);
      finish(e.code === "ENOENT" || file === "" ? 127 : 126);
    };
    try {
      // Same env merge as `runShellAsync`: `childEnv()` is only the holder-id delta.
      child = d.spawn(file, fileArgs, { env: { ...d.env, ...got.childEnv() } });
    } catch (e) {
      // Node throws, rather than emitting 'error', for an empty program name and most errnos (ENOEXEC, ENOTDIR, ELOOP).
      return cannotRun(e as NodeJS.ErrnoException);
    }
    child.once("error", cannotRun);
    child.once("close", (code, signal) => {
      const exit = signalled !== undefined ? 128 + signalled : (code ?? 128 + (constants.signals[signal!] ?? 0));
      if (args.shell !== undefined && exit === 127) {
        d.err("lease: command not found inside the wrapper; shell functions and aliases are not available under --shell");
      }
      finish(exit);
    });
    if (child.pid === undefined) return;
    try {
      got.setChildPid(child.pid);
    } catch (e) {
      child.kill("SIGKILL");
      d.err(`lease: could not record the child PID: ${(e as Error).message}`);
      finish(1);
    }
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------

/**
 * The deps `main` runs with: every lease, sink, policy and sampler diagnostic goes through `err`.
 * `base.env` replaces `process.env` everywhere the CLI reads the environment (the lease options, `CO_LEASE_MAX_WAIT` and the child's env);
 * `base.level` replaces the sampler, so none is built. `main` passes neither; tests pass both to stay hermetic.
 */
export function cliLeaseDeps(err: (line: string) => void, base: { env?: NodeJS.ProcessEnv; level?: PressureSampler } = {}): LeaseCliDeps {
  const { env = process.env, level } = base;
  return {
    leaseOptions: () => defaultLeaseOptions(env, { warn: err, level }),
    acquire: acquireLease,
    leaseStatus,
    ancestors: psAncestors,
    spawn: (file, fileArgs, opts) => spawn(file, fileArgs, { stdio: "inherit", env: opts.env }),
    env,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err,
    signals: process,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  // Before the usage and configuration exits: hook mode never fails a Bash call.
  if (argv[0] === "hook") return runHook(argv.slice(1), { env: process.env, readStdin, out: (text) => void process.stdout.write(text) });
  let args: LeaseArgs;
  try {
    args = parseLeaseArgs(argv);
  } catch (err) {
    process.stderr.write(`lease: ${(err as Error).message}\nusage: claude-orchestrator-lease [--max-wait <sec>] [--label <text>] (-- <cmd> [args...] | --shell '<command line>') | status | hook [--print-settings-entry]\n`);
    return EX_USAGE;
  }
  const deps = cliLeaseDeps((line) => {
    process.stderr.write(`${line}\n`);
  });
  return args.kind === "status" ? runStatus(deps) : runLeased(args, deps);
}

// A bin is run through a symlink (`node_modules/.bin/...`), so compare real paths.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entryPath === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`lease: ${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
