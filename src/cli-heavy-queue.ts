#!/usr/bin/env node
/**
 * The front end for heavy-queue's syntax, backed by the machine-wide lease (heavy-queue's second line folded into the first):
 *
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] -- <cmd> [args...]
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] --shell '<command line>'
 *   heavy-queue status
 *   heavy-queue watch [--interval <sec>]
 *
 * Installed as `claude-orchestrator-heavy-queue`, and behind a two-line `sh` shim at heavy-queue's old path (README, "Heavy-command lease").
 * A run waits with no cap (no `--max-wait`, `CO_LEASE_MAX_WAIT` ignored, never exit 75), in its own gated, background, suspendable
 * holder with no ancestor borrow, and returns the command's exit code (`--priority high`: first in line, no `taskpolicy -b`, never suspendable, every limit kept); a usage error exits 2, disk full 74, a bad lease directory 78.
 * `status` is the lease's own (`runStatus`); `watch` redraws the same view as tables every interval (2 s by default) until Ctrl-C (`heavy-queue-watch.ts`). The run function lives in `lease-run.ts`; this file never imports `cli-lease.ts`, which runs a startup check at load.
 */

import { cliLeaseDeps, runLeased, runStatus, statusView, type LeaseArgs, type LeaseCliDeps } from "./lease-run.js";
import { MAX_WATCH_INTERVAL_SEC, MIN_WATCH_INTERVAL_SEC, runWatch, type WatchArgs, type WatchDeps } from "./heavy-queue-watch.js";
import type { LeaseOptions } from "./lease.js";
import { isEntryPoint } from "./entry-point.js";

const EX_USAGE = 2;
const USAGE = `usage: heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] (-- <cmd> [args...] | --shell '<command line>')
       heavy-queue status
       heavy-queue watch [--interval <sec>]`;
const EX_CONFIG = 78;
const DEFAULT_WATCH_INTERVAL_SEC = 2;

/**
 * Parses heavy-queue's arguments (`run [--label L] [--priority normal|high] [--no-suspend] (--shell C | -- argv...)`, `status`, `watch [--interval S]`); `undefined` is a usage error.
 * The options come in any order before the command, each at most once. `--priority normal` parses to the same result as no `--priority`.
 */
export function parseHeavyQueueArgs(argv: string[]): LeaseArgs | WatchArgs | undefined {
  if (argv[0] === "status") return { kind: "status" };
  if (argv[0] === "watch") {
    if (argv.length === 1) return { kind: "watch", intervalSec: DEFAULT_WATCH_INTERVAL_SEC };
    const sec = Number(argv[2]);
    return argv.length === 3 && argv[1] === "--interval" && argv[2]!.trim() !== "" && sec >= MIN_WATCH_INTERVAL_SEC && sec <= MAX_WATCH_INTERVAL_SEC ? { kind: "watch", intervalSec: sec } : undefined;
  }
  if (argv[0] !== "run") return undefined;
  let rest = argv.slice(1);
  let label: string | undefined;
  let priority: string | undefined;
  let noSuspend = false;
  for (;;) {
    if (rest[0] === "--label" && rest.length >= 2 && label === undefined) [label, ...rest] = rest.slice(1);
    else if (rest[0] === "--priority" && rest.length >= 2 && priority === undefined) [priority, ...rest] = rest.slice(1);
    else if (rest[0] === "--no-suspend" && !noSuspend) [noSuspend, rest] = [true, rest.slice(1)];
    else break;
  }
  if (priority !== undefined && priority !== "normal" && priority !== "high") return undefined;
  const high = priority === "high";
  const command = rest[0] === "--shell" && rest.length === 2 ? { shell: rest[1] } : rest[0] === "--" && rest.length >= 2 ? { argv: rest.slice(1) } : undefined;
  return command && { kind: "run", label: label ?? "unlabelled", ...command, ...(noSuspend && { noSuspend }), ...(high && { priority: "high" as const }), gated: true, background: true, suspendable: true, uncapped: true };
}

/** `watch`'s process side: the lease read through `d` with options built once, the terminal and signals through `process`. */
export function processWatchDeps(d: LeaseCliDeps, opts: LeaseOptions, notes: () => readonly string[]): WatchDeps {
  return {
    status: () => statusView(d, opts),
    now: () => new Date(),
    every: (fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    write: (t) => void process.stdout.write(t),
    isTTY: process.stdout.isTTY === true,
    columns: () => process.stdout.columns || 80,
    rows: () => process.stdout.rows || 24,
    notes,
    // A closed pipe (`watch | head`) reports EPIPE as an 'error' event, which would otherwise crash the process.
    onStop: (fn) => {
      process.once("SIGINT", fn);
      process.once("SIGTERM", fn);
      process.stdout.once("error", fn);
      return () => {
        process.off("SIGINT", fn);
        process.off("SIGTERM", fn);
        process.stdout.off("error", fn);
      };
    },
  };
}

/** Builds the lease options once, sending their warnings into a list the watch draws, so stderr never writes over the screen; 78 on a misconfigured lease, as `status` does. */
async function watch(args: WatchArgs, d: LeaseCliDeps, watchDeps: WatchDepsFactory): Promise<number> {
  const notes: string[] = [];
  const note = (line: string): void => void (notes.includes(line) || notes.push(line));
  let opts: LeaseOptions;
  try {
    opts = d.leaseOptions(note);
  } catch (err) {
    d.err(`lease: ${(err as Error).message}`);
    return EX_CONFIG;
  }
  return runWatch(args, watchDeps(d, opts, () => notes));
}

type WatchDepsFactory = (d: LeaseCliDeps, opts: LeaseOptions, notes: () => readonly string[]) => WatchDeps;

export async function runHeavyQueue(argv: string[], d: LeaseCliDeps, watchDeps: WatchDepsFactory = processWatchDeps): Promise<number> {
  const args = parseHeavyQueueArgs(argv);
  if (!args) {
    d.err(USAGE);
    return EX_USAGE;
  }
  if (args.kind === "watch") return watch(args, d, watchDeps);
  return args.kind === "status" ? runStatus(d) : runLeased(args, d);
}

if (isEntryPoint(import.meta.url, import.meta.main)) {
  runHeavyQueue(process.argv.slice(2), cliLeaseDeps((line) => void process.stderr.write(`${line}\n`))).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`heavy-queue: ${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
