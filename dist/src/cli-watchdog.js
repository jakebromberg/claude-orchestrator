#!/usr/bin/env node
/**
 * Reports stopped engine and session trees from outside every tree:
 *
 *   claude-orchestrator-watchdog check   scan once; update watchdog.json, watchdog.log and watchdog.brief
 *   claude-orchestrator-watchdog brief   print watchdog.brief (nothing when all is well)
 *
 * State lives in the lease directory. The logic is in `watchdog.ts`; this file wires the real `ps` and clock.
 * Exit 78 means the lease directory is misconfigured (a relative `CO_LEASE_DIR`).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leaseDirectory } from "./memory-pressure.js";
import { runWatchdog, scanProcessTable } from "./watchdog.js";
const EX_CONFIG = 78;
function main(argv) {
    const err = (line) => void process.stderr.write(`${line}\n`);
    let dir;
    try {
        dir = leaseDirectory(process.env);
    }
    catch (e) {
        err(`watchdog: ${e.message}`);
        return EX_CONFIG;
    }
    return runWatchdog(argv, { dir, scan: scanProcessTable, now: Date.now, out: (line) => void process.stdout.write(`${line}\n`), err });
}
// A bin is run through a symlink (`node_modules/.bin/...`), so compare real paths.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entryPath === realpathSync(fileURLToPath(import.meta.url)))
    process.exitCode = main(process.argv.slice(2));
//# sourceMappingURL=cli-watchdog.js.map