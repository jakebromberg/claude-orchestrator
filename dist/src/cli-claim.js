#!/usr/bin/env node
/**
 * CLI helper that lets agents claim a guaranteed-unique sequential number
 * from the orchestrator's counter store. Invoked by the agent from inside its
 * worktree as: `node cli-claim.js --config <yaml> --issue <n> --domain <name>`
 *
 * The orchestrator pre-formats this command into the `{{CLAIM_NUMBER}}`
 * prompt template variable so the agent only needs to append a domain name.
 *
 * Pure helpers (`parseClaimArgs`, `runClaim`) are exported for testing; the
 * file's bottom is the CLI entry-point that wires real I/O.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { YamlConfigSchema } from "./yaml-schema.js";
import { FileCounterStore } from "./counter-store.js";
import { seedFromGit } from "./seed-from-git.js";
export function parseClaimArgs(argv) {
    let config;
    let issue;
    let domain;
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case "--config": {
                const v = argv[i + 1];
                if (!v)
                    throw new Error("--config requires a path");
                config = v;
                i += 2;
                break;
            }
            case "--issue": {
                const v = argv[i + 1];
                if (!v)
                    throw new Error("--issue requires a number");
                const n = parseInt(v, 10);
                if (!Number.isFinite(n))
                    throw new Error("--issue must be a number");
                issue = n;
                i += 2;
                break;
            }
            case "--domain": {
                const v = argv[i + 1];
                if (!v)
                    throw new Error("--domain requires a name");
                domain = v;
                i += 2;
                break;
            }
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!config)
        throw new Error("--config is required");
    if (issue === undefined)
        throw new Error("--issue is required");
    if (!domain)
        throw new Error("--domain is required");
    return { config, issue, domain };
}
export function runClaim(opts) {
    if (!opts.yaml.sequentialDomains) {
        throw new Error("Config has no sequentialDomains; cannot claim a number.");
    }
    const config = opts.yaml.sequentialDomains[opts.domain];
    if (!config) {
        const known = Object.keys(opts.yaml.sequentialDomains).join(", ") || "(none)";
        throw new Error(`Unknown domain "${opts.domain}". Known: ${known}.`);
    }
    const claim = opts.store.claim(opts.domain, opts.issue, config.width, opts.seed);
    return claim.formatted;
}
// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------
function loadYaml(yamlPath) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    const yaml = YamlConfigSchema.parse(parsed);
    const yamlDir = path.dirname(path.resolve(yamlPath));
    yaml.configDir = path.resolve(yamlDir, yaml.configDir);
    yaml.projectRoot = path.resolve(yamlDir, yaml.projectRoot);
    return yaml;
}
function main() {
    const args = parseClaimArgs(process.argv.slice(2));
    const yaml = loadYaml(args.config);
    const baseBranch = yaml.baseBranch ?? "main";
    const domainConfig = yaml.sequentialDomains?.[args.domain];
    const store = new FileCounterStore(yaml.configDir);
    const seed = () => domainConfig
        ? seedFromGit({ runCommand: (cmd) => execSync(cmd, { encoding: "utf-8" }) }, {
            repoDir: yaml.projectRoot,
            baseBranch,
            paths: domainConfig.paths,
        })
        : 1;
    const formatted = runClaim({
        yaml,
        issue: args.issue,
        domain: args.domain,
        store,
        seed,
    });
    process.stdout.write(formatted + "\n");
}
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
    try {
        main();
    }
    catch (err) {
        process.stderr.write(`claim failed: ${err.message}\n`);
        process.exit(1);
    }
}
//# sourceMappingURL=cli-claim.js.map