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
import { type CounterStore } from "./counter-store.js";
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
export declare function parseClaimArgs(argv: string[]): ClaimArgs;
export interface RunClaimOptions {
    yaml: YamlConfig;
    issue: number;
    domain: string;
    store: CounterStore;
    seed: () => number;
}
/**
 * Base branch to seed a claim against, resolved from the claiming issue's repo
 * (iOS `master`, others `main`) via the `repos:` map, falling back to
 * `defaultRepo` and the top-level default. Bare-number targeting: when the same
 * number exists in multiple repos the first declared issue wins — acceptable
 * because claim domains (e.g. migrations) live in a single repo.
 */
export declare function resolveClaimBaseBranch(yaml: YamlConfig, issueNumber: number): string;
export declare function runClaim(opts: RunClaimOptions): ClaimResult;
