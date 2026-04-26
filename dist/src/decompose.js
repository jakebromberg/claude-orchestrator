/**
 * LLM-driven task decomposition module.
 *
 * Takes a feature description and uses Claude CLI to generate a
 * structured issue breakdown with dependency relationships.
 */
import { computeWaves } from "./dag.js";
const DECOMPOSE_PROMPT = `You are a software architect. Given a feature description, decompose it into a set of focused implementation tasks (issues) that can be worked on by individual developers.

Each issue should:
- Have a short, kebab-case slug (e.g., "auth-module", "api-routes")
- Have a clear description of what needs to be built
- List dependencies on other issues by slug (dependsOn array)
- Be small enough to implement in a single PR (ideally under 500 lines)

Output ONLY valid JSON in this exact format:
{
  "issues": [
    { "slug": "example-slug", "description": "What to build", "dependsOn": [] },
    { "slug": "another-slug", "description": "Depends on first", "dependsOn": ["example-slug"] }
  ]
}

Rules:
- No circular dependencies
- Every dependency must reference an existing slug
- Issues with no dependencies come first
- Aim for 3-10 issues
- Group independent work that can be parallelized

IMPORTANT: Output ONLY the JSON object. No markdown, no explanation, no code fences.`;
/**
 * Decompose a feature description into structured issues using Claude CLI.
 *
 * @param input - Feature description and optional context
 * @param deps - Injectable dependencies
 * @returns Decomposed issues and a YAML config fragment
 */
export async function decompose(input, deps) {
    if (!input.featureDescription.trim()) {
        throw new Error("Feature description is required");
    }
    // Build the full prompt with all available context
    let fullPrompt = DECOMPOSE_PROMPT + "\n\n## Feature Description\n\n" + input.featureDescription;
    // Add file context if provided
    if (input.featureFile) {
        const fileContent = deps.readFile(input.featureFile);
        fullPrompt += "\n\n## Additional Context (from file)\n\n" + fileContent;
    }
    // Fetch GitHub issue body if provided
    if (input.issueNumber && input.repo) {
        const issueBody = deps.runCommand(`gh issue view ${input.issueNumber} --repo ${input.repo} --json body -q .body`);
        fullPrompt += "\n\n## GitHub Issue Context\n\n" + issueBody;
    }
    // Add project context if provided
    if (input.projectContext) {
        fullPrompt += "\n\n## Project Context\n\n" + input.projectContext;
    }
    // Call Claude CLI
    deps.logger.step("Invoking Claude for task decomposition...");
    const rawOutput = deps.runCommand(`claude -p ${escapeShellArg(fullPrompt)} --output-format json`);
    // Parse response
    let parsed;
    try {
        parsed = JSON.parse(rawOutput);
    }
    catch {
        throw new Error(`Failed to parse Claude output as JSON: ${rawOutput.slice(0, 200)}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.issues)) {
        throw new Error("Claude output missing required 'issues' array");
    }
    const rawIssues = parsed.issues;
    // Validate structure
    for (const issue of rawIssues) {
        if (!issue.slug || !issue.description) {
            throw new Error(`Issue missing slug or description: ${JSON.stringify(issue)}`);
        }
        if (!Array.isArray(issue.dependsOn)) {
            issue.dependsOn = [];
        }
    }
    // Validate no cycles by converting to IssueSpec format and running computeWaves
    const slugToNumber = new Map();
    rawIssues.forEach((issue, i) => slugToNumber.set(issue.slug, i + 1));
    const issueSpecs = rawIssues.map((issue, i) => ({
        number: i + 1,
        slug: issue.slug,
        description: issue.description,
        dependsOn: issue.dependsOn
            .map((dep) => slugToNumber.get(dep))
            .filter((n) => n !== undefined),
    }));
    // This will throw if there are cycles
    computeWaves(issueSpecs);
    deps.logger.info(`Decomposed into ${rawIssues.length} issues`);
    // Generate YAML fragment
    const yamlFragment = generateYamlFragment(rawIssues);
    return {
        issues: rawIssues,
        yamlFragment,
    };
}
function generateYamlFragment(issues) {
    const lines = ["issues:"];
    for (const issue of issues) {
        lines.push(`  - number: TBD`);
        lines.push(`    slug: ${issue.slug}`);
        if (issue.dependsOn.length === 0) {
            lines.push("    dependsOn: []");
        }
        else {
            lines.push(`    dependsOn: [${issue.dependsOn.map((d) => `TBD`).join(", ")}]  # ${issue.dependsOn.join(", ")}`);
        }
        lines.push(`    description: "${escapeYamlString(issue.description)}"`);
    }
    return lines.join("\n");
}
function escapeShellArg(arg) {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}
function escapeYamlString(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
//# sourceMappingURL=decompose.js.map