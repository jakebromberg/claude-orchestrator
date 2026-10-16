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
import { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus } from "./lease-run.js";
export { formatAdmitted, formatNoSlot };
export { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus };
export type { LeaseArgs, LeaseChild, LeaseCliDeps, RunArgs } from "./lease-run.js";
