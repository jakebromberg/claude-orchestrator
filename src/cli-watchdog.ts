#!/usr/bin/env node
/**
 * Reports stopped engine and session trees from outside every tree:
 *
 *   claude-orchestrator-watchdog check   scan once; update watchdog.json, watchdog.log and watchdog.brief
 *   claude-orchestrator-watchdog brief   print watchdog.brief, then a disk-full line when the lease volume is nearly full (nothing when all is well)
 *   claude-orchestrator-watchdog print-plist         print the LaunchAgent plist (refuses from a git worktree)
 *   claude-orchestrator-watchdog print-status-line   print the status-line shell fragment (no node)
 *
 * State lives in the lease directory. The logic is in `watchdog.ts`; this file wires the real `ps` and clock.
 * Exit 78 means the lease directory is misconfigured (a relative `CO_LEASE_DIR`).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leaseDirectory } from "./memory-pressure.js";
import { checkoutOf, isGitWorktree, runPrint } from "./watchdog-install.js";
import { runWatchdog, scanProcessTable } from "./watchdog.js";
import { isEntryPoint } from "./entry-point.js";

const EX_CONFIG = 78;

function main(argv: string[]): number {
  const err = (line: string): void => void process.stderr.write(`${line}\n`);
  let dir: string;
  try {
    dir = leaseDirectory(process.env);
  } catch (e) {
    err(`watchdog: ${(e as Error).message}`);
    return EX_CONFIG;
  }
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const checkout = checkoutOf(realpathSync(fileURLToPath(import.meta.url)));
  const printed = runPrint(argv, { dir, node: process.execPath, checkout, isWorktree: isGitWorktree, out, err });
  if (printed !== undefined) return printed;
  return runWatchdog(argv, { dir, scan: scanProcessTable, now: Date.now, out, err });
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
