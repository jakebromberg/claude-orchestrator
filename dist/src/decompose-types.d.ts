import type { Logger } from "./types.js";
/** Input for the decompose function. */
export interface DecomposeInput {
    /** Natural language description of the feature to decompose. */
    featureDescription: string;
    /** Path to a file containing additional feature context. */
    featureFile?: string;
    /** GitHub issue number to fetch description from. */
    issueNumber?: number;
    /** GitHub repo (owner/repo) for issue fetching. */
    repo?: string;
    /** Additional project context to include in the prompt. */
    projectContext?: string;
}
/** A single decomposed issue from the LLM output. */
export interface DecomposedIssue {
    slug: string;
    description: string;
    dependsOn: string[];
}
/** Result of the decompose function. */
export interface DecomposeResult {
    issues: DecomposedIssue[];
    /** YAML fragment string ready to paste into an orchestrator config. */
    yamlFragment: string;
}
/** Dependencies for decompose, injectable for testing. */
export interface DecomposeDeps {
    runCommand: (cmd: string, options?: {
        input?: string;
    }) => string;
    readFile: (path: string) => string;
    logger: Logger;
}
