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
import { cliLeaseDeps, runLeased, runStatus } from "./lease-run.js";
import { isEntryPoint } from "./entry-point.js";
const EX_USAGE = 2;
const USAGE = `usage: heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] (-- <cmd> [args...] | --shell '<command line>')
       heavy-queue status`;
/**
 * Parses heavy-queue's arguments (`run [--label L] [--priority normal|high] [--no-suspend] (--shell C | -- argv...)`, `status`); `undefined` is a usage error.
 * The options come in any order before the command, each at most once. `--priority normal` parses to the same result as no `--priority`.
 */
export function parseHeavyQueueArgs(argv) {
    if (argv[0] === "status")
        return { kind: "status" };
    if (argv[0] !== "run")
        return undefined;
    let rest = argv.slice(1);
    let label;
    let priority;
    let noSuspend = false;
    for (;;) {
        if (rest[0] === "--label" && rest.length >= 2 && label === undefined)
            [label, ...rest] = rest.slice(1);
        else if (rest[0] === "--priority" && rest.length >= 2 && priority === undefined)
            [priority, ...rest] = rest.slice(1);
        else if (rest[0] === "--no-suspend" && !noSuspend)
            [noSuspend, rest] = [true, rest.slice(1)];
        else
            break;
    }
    if (priority !== undefined && priority !== "normal" && priority !== "high")
        return undefined;
    const high = priority === "high";
    const command = rest[0] === "--shell" && rest.length === 2 ? { shell: rest[1] } : rest[0] === "--" && rest.length >= 2 ? { argv: rest.slice(1) } : undefined;
    return command && { kind: "run", label: label ?? "unlabelled", ...command, ...(noSuspend && { noSuspend }), ...(high && { priority: "high" }), gated: true, background: true, suspendable: true, uncapped: true };
}
export async function runHeavyQueue(argv, d) {
    const args = parseHeavyQueueArgs(argv);
    if (!args) {
        d.err(USAGE);
        return EX_USAGE;
    }
    return args.kind === "status" ? runStatus(d) : runLeased(args, d);
}
if (isEntryPoint(import.meta.url, import.meta.main)) {
    runHeavyQueue(process.argv.slice(2), cliLeaseDeps((line) => void process.stderr.write(`${line}\n`))).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`heavy-queue: ${err.message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli-heavy-queue.js.map