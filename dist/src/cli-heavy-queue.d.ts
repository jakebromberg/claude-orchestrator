#!/usr/bin/env node
/**
 * The front end for heavy-queue's syntax, backed by the machine-wide lease (heavy-queue's second line folded into the first):
 *
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] -- <cmd> [args...]
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] --shell '<command line>'
 *   heavy-queue status
 *
 * Installed as `claude-orchestrator-heavy-queue`, and behind a two-line `sh` shim at heavy-queue's old path (README, "Heavy-command lease").
 * A run waits with no cap (no `--max-wait`, `CO_LEASE_MAX_WAIT` ignored, never exit 75), in its own gated, background, suspendable
 * holder with no ancestor borrow, and returns the command's exit code (`--priority high`: first in line, no `taskpolicy -b`, never suspendable, every limit kept); a usage error exits 2, disk full 74, a bad lease directory 78.
 * `status` is the lease's own (`runStatus`). The run function lives in `lease-run.ts`; this file never imports `cli-lease.ts`, which runs a startup check at load.
 */
import { type LeaseArgs, type LeaseCliDeps } from "./lease-run.js";
/**
 * Parses heavy-queue's arguments (`run [--label L] [--priority normal|high] [--no-suspend] (--shell C | -- argv...)`, `status`); `undefined` is a usage error.
 * The options come in any order before the command, each at most once. `--priority normal` parses to the same result as no `--priority`.
 */
export declare function parseHeavyQueueArgs(argv: string[]): LeaseArgs | undefined;
export declare function runHeavyQueue(argv: string[], d: LeaseCliDeps): Promise<number>;
