/**
 * LLM-driven task decomposition module.
 *
 * Takes a feature description and uses Claude CLI to generate a
 * structured issue breakdown with dependency relationships.
 */
import type { DecomposeInput, DecomposeResult, DecomposeDeps } from "./decompose-types.js";
/**
 * Decompose a feature description into structured issues using Claude CLI.
 *
 * @param input - Feature description and optional context
 * @param deps - Injectable dependencies
 * @returns Decomposed issues and a YAML config fragment
 */
export declare function decompose(input: DecomposeInput, deps: DecomposeDeps): Promise<DecomposeResult>;
