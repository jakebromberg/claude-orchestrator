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
import { FileCounterStore, type CounterStore } from "./counter-store.js";
import { seedFromGit } from "./seed-from-git.js";
import { resolveYamlPaths } from "./yaml-loader.js";
import type { YamlConfig } from "./yaml-types.js";

export interface ClaimArgs {
  config: string;
  issue: number;
  domain: string;
}

/**
 * The result of a successful claim. `number` is the raw integer; `formatted`
 * is the same value zero-padded to the domain's configured width — what the
 * agent reads from stdout and embeds in a filename.
 */
export interface ClaimResult {
  number: number;
  formatted: string;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${flag} requires an argument`);
  }
  return v;
}

export function parseClaimArgs(argv: string[]): ClaimArgs {
  let config: string | undefined;
  let issue: number | undefined;
  let domain: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "--config": {
        if (config !== undefined) throw new Error("--config given more than once");
        config = takeValue(argv, i, "--config");
        i += 2;
        break;
      }
      case "--issue": {
        if (issue !== undefined) throw new Error("--issue given more than once");
        const v = takeValue(argv, i, "--issue");
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== v) {
          throw new Error("--issue must be an integer");
        }
        issue = n;
        i += 2;
        break;
      }
      case "--domain": {
        if (domain !== undefined) throw new Error("--domain given more than once");
        domain = takeValue(argv, i, "--domain");
        i += 2;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config) throw new Error("--config is required");
  if (issue === undefined) throw new Error("--issue is required");
  if (!domain) throw new Error("--domain is required");
  return { config, issue, domain };
}

export interface RunClaimOptions {
  yaml: YamlConfig;
  issue: number;
  domain: string;
  store: CounterStore;
  seed: () => number;
}

export function runClaim(opts: RunClaimOptions): ClaimResult {
  if (!opts.yaml.sequentialDomains) {
    throw new Error(
      "Config has no sequentialDomains; cannot claim a number.",
    );
  }
  const config = opts.yaml.sequentialDomains[opts.domain];
  if (!config) {
    const known = Object.keys(opts.yaml.sequentialDomains).join(", ") || "(none)";
    throw new Error(
      `Unknown domain "${opts.domain}". Known: ${known}.`,
    );
  }
  const number = opts.store.claim(opts.domain, opts.issue, opts.seed);
  return { number, formatted: String(number).padStart(config.width, "0") };
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------

function loadYaml(yamlPath: string): YamlConfig {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw);
  const yaml = YamlConfigSchema.parse(parsed) as YamlConfig;
  resolveYamlPaths(yaml, path.dirname(path.resolve(yamlPath)));
  return yaml;
}

function main(): void {
  const args = parseClaimArgs(process.argv.slice(2));
  const yaml = loadYaml(args.config);
  const baseBranch = yaml.baseBranch ?? "main";
  // `runClaim` rejects unknown domains before the seed function fires, so
  // domainConfig is guaranteed to exist when seed() is invoked.
  const domainConfig = yaml.sequentialDomains?.[args.domain]!;

  const store = new FileCounterStore(yaml.configDir);
  const seed = (): number =>
    seedFromGit(
      { runCommand: (cmd: string) => execSync(cmd, { encoding: "utf-8" }) },
      {
        repoDir: yaml.projectRoot,
        baseBranch,
        paths: domainConfig.paths,
      },
    );

  const claim = runClaim({
    yaml,
    issue: args.issue,
    domain: args.domain,
    store,
    seed,
  });
  process.stdout.write(claim.formatted + "\n");
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`claim failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
