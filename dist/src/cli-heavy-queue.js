#!/usr/bin/env node
/**
 * The front end for heavy-queue's syntax, backed by the machine-wide lease (heavy-queue's second line folded into the first):
 *
 *   heavy-queue run --label "<session>: <what>" [--no-suspend] -- <cmd> [args...]
 *   heavy-queue run --label "<session>: <what>" [--no-suspend] --shell '<command line>'
 *   heavy-queue status
 *
 * Installed as `claude-orchestrator-heavy-queue`, and behind a two-line `sh` shim at heavy-queue's old path (README, "Heavy-command lease").
 * A run waits with no cap (no `--max-wait`, `CO_LEASE_MAX_WAIT` ignored, never exit 75), in its own gated, background, suspendable
 * holder with no ancestor borrow, and returns the command's exit code; a usage error exits 2, disk full 74, a bad lease directory 78.
 * `status` is the lease's own (`runStatus`). The run function lives in `lease-run.ts`; this file never imports `cli-lease.ts`, which runs a startup check at load.
 */
import { cliLeaseDeps, runLeased, runStatus } from "./lease-run.js";
import { isEntryPoint } from "./entry-point.js";
const EX_USAGE = 2;
const USAGE = `usage: heavy-queue run --label "<session>: <what>" [--no-suspend] (-- <cmd> [args...] | --shell '<command line>')
       heavy-queue status`;
/** Parses heavy-queue's arguments (`run [--label L] [--no-suspend] (--shell C | -- argv...)`, `status`); `undefined` is a usage error. */
export function parseHeavyQueueArgs(argv) {
    if (argv[0] === "status")
        return { kind: "status" };
    if (argv[0] !== "run")
        return undefined;
    let rest = argv.slice(1);
    let label = "unlabelled";
    if (rest[0] === "--label" && rest.length >= 2)
        [label, ...rest] = rest.slice(1);
    const noSuspend = rest[0] === "--no-suspend";
    if (noSuspend)
        rest = rest.slice(1);
    const command = rest[0] === "--shell" && rest.length === 2 ? { shell: rest[1] } : rest[0] === "--" && rest.length >= 2 ? { argv: rest.slice(1) } : undefined;
    return command && { kind: "run", label, ...command, ...(noSuspend && { noSuspend }), gated: true, background: true, suspendable: true, uncapped: true };
}
export async function runHeavyQueue(argv, d) {
    const args = parseHeavyQueueArgs(argv);
    if (!args) {
        d.err(USAGE);
        return EX_USAGE;
    }
    return args.kind === "status" ? runStatus(d) : runLeased(args, d);
}
if (isEntryPoint(import.meta.url)) {
    runHeavyQueue(process.argv.slice(2), cliLeaseDeps((line) => void process.stderr.write(`${line}\n`))).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`heavy-queue: ${err.message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli-heavy-queue.js.map