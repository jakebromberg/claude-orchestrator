#!/usr/bin/env node
/**
 * Runs a command under the machine-wide heavy-command lease, or reports who
 * holds it:
 *
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] -- <cmd> [args...]
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] --shell '<command line>'
 *   claude-orchestrator-lease status
 *   claude-orchestrator-lease hook [--print-settings-entry]
 *   claude-orchestrator-lease suspend <pgid> --by <who> --reason <why> [--remind 2h] [--record-only]
 *   claude-orchestrator-lease resume <pgid>
 *
 * The slot is held for exactly as long as the command lives, and the command's
 * exit code is passed through. Exit 75 means no slot within the wait cap
 * (rerun); exit 78 means the lease is misconfigured (a relative `CO_LEASE_DIR`).
 *
 * The run function and its deps live in `lease-run.ts` (no load-time work) and are
 * re-exported here; the file's bottom wires the entry point.
 */

import { formatAdmitted, formatNoSlot } from "./lease-messages.js";
import { runHook } from "./lease-hook.js";
import { runSuspensionCli } from "./suspensions.js";
import { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus, type LeaseArgs } from "./lease-run.js";
import { isEntryPoint } from "./entry-point.js";

export { formatAdmitted, formatNoSlot };
export { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus };
export type { LeaseArgs, LeaseChild, LeaseCliDeps, RunArgs } from "./lease-run.js";

const EX_USAGE = 64;

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  // Before the usage and configuration exits: hook mode never fails a Bash call.
  if (argv[0] === "hook") return runHook(argv.slice(1), { env: process.env, readStdin, out: (text) => void process.stdout.write(text) });
  if (argv[0] === "suspend" || argv[0] === "resume") return runSuspensionCli(argv);
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

if (isEntryPoint(import.meta.url)) {
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
