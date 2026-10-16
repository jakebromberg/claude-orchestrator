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
 * The run function and its deps live in `lease-run.ts` (no load-time work) and are
 * re-exported here; the file's bottom wires the entry point.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAdmitted, formatNoSlot } from "./lease-messages.js";
import { runHook } from "./lease-hook.js";
import { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus } from "./lease-run.js";
export { formatAdmitted, formatNoSlot };
export { cliLeaseDeps, parseLeaseArgs, runLeased, runStatus };
const EX_USAGE = 64;
// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
async function main(argv) {
    // Before the usage and configuration exits: hook mode never fails a Bash call.
    if (argv[0] === "hook")
        return runHook(argv.slice(1), { env: process.env, readStdin, out: (text) => void process.stdout.write(text) });
    let args;
    try {
        args = parseLeaseArgs(argv);
    }
    catch (err) {
        process.stderr.write(`lease: ${err.message}\nusage: claude-orchestrator-lease [--max-wait <sec>] [--label <text>] (-- <cmd> [args...] | --shell '<command line>') | status | hook [--print-settings-entry]\n`);
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
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`lease: ${err.message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli-lease.js.map