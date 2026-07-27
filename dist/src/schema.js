import { z } from "zod/v4";
import { computeWaves } from "./dag.js";
import { refOf, normalizeDep } from "./ref.js";
const IssueSpecSchema = z.object({
    number: z.number().int().positive(),
    slug: z.string().min(1),
    // A dep is a bare number/numeric string (same repo) or a qualified
    // cross-repo ref "owner/repo#N". Referential validity is checked below.
    dependsOn: z.array(z.union([z.number().int().positive(), z.string().min(1)])),
    description: z.string().min(1),
    repo: z.string().optional(),
    mode: z.enum(["deploy", "publish", "gate"]).optional(),
    command: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    complexity: z.enum(["mechanical", "normal", "complex"]).optional(),
    extraDirs: z.array(z.string().min(1)).optional(),
    stallTimeout: z.number().int().min(0).optional(),
    serial: z.boolean().optional(),
    ownsFiles: z.array(z.string().min(1)).optional(),
});
const RawConfigSchema = z
    .object({
    name: z.string().min(1),
    configDir: z.string().min(1),
    worktreeDir: z.string().min(1),
    projectRoot: z.string().min(1),
    stallTimeout: z.number().int().min(0),
    issues: z.array(IssueSpecSchema),
    hooks: z.any(),
    allowedTools: z.array(z.string()).optional(),
    defaultRepo: z.string().optional(),
    defaultModel: z.string().min(1).optional(),
    defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    issueComments: z.object({ repo: z.string(), enabled: z.boolean() }).optional(),
    labelSync: z.object({ prefix: z.string(), repo: z.string().optional() }).optional(),
    retryOnCheckFailure: z.object({ maxRetries: z.number().int().positive(), enabled: z.boolean() }).optional(),
})
    .check((ctx) => {
    const issues = ctx.value.issues;
    const input = ctx.value;
    const defaultRepo = ctx.value.defaultRepo;
    // Issues are identified by ref, so the same number in two repos is not a
    // duplicate. Slugs remain globally unique (they name worktrees/branches).
    const refs = new Set();
    const slugs = new Set();
    for (const issue of issues) {
        const ref = refOf(issue, defaultRepo);
        if (refs.has(ref)) {
            ctx.issues.push({
                code: "custom",
                input,
                message: `Duplicate issue (same repo and number): ${ref}`,
                path: ["issues"],
            });
            return;
        }
        refs.add(ref);
        if (slugs.has(issue.slug)) {
            ctx.issues.push({
                code: "custom",
                input,
                message: `Duplicate slug: "${issue.slug}"`,
                path: ["issues"],
            });
            return;
        }
        slugs.add(issue.slug);
    }
    // A mode-node (deploy/publish/gate) currently runs a configured command in
    // place of a Claude session, so it must carry one. (Command-less manual
    // gates arrive with the cutover gate in A5b-2, which relaxes this.)
    for (const issue of issues) {
        if (issue.mode && !issue.command) {
            ctx.issues.push({
                code: "custom",
                input,
                message: `Issue ${refOf(issue, defaultRepo)} has mode "${issue.mode}" but no command; a mode-node requires a command to run.`,
                path: ["issues"],
            });
            return;
        }
    }
    // Check dependency references by ref.
    for (const issue of issues) {
        const ref = refOf(issue, defaultRepo);
        for (const dep of issue.dependsOn) {
            const depRef = normalizeDep(dep, issue, defaultRepo);
            if (depRef === ref) {
                ctx.issues.push({
                    code: "custom",
                    input,
                    message: `Issue ${ref} has a self-referencing dependency`,
                    path: ["issues"],
                });
                return;
            }
            if (!refs.has(depRef)) {
                ctx.issues.push({
                    code: "custom",
                    input,
                    message: `Issue ${ref} depends on ${depRef}, which does not exist`,
                    path: ["issues"],
                });
                return;
            }
        }
    }
    // Check for cycles via computeWaves.
    try {
        computeWaves(issues, { defaultRepo });
    }
    catch (err) {
        ctx.issues.push({
            code: "custom",
            input,
            message: err.message,
            path: ["issues"],
        });
    }
});
/**
 * Validate a raw orchestrator config and compute wave assignments.
 *
 * Throws a ZodError if structural, referential, or graph validation fails.
 */
export function validateConfig(raw, options) {
    const parsed = RawConfigSchema.parse(raw);
    const issues = computeWaves(parsed.issues, {
        ignoredOwnsFiles: options?.ignoredOwnsFiles,
        defaultRepo: parsed.defaultRepo,
    });
    return {
        name: parsed.name,
        configDir: parsed.configDir,
        worktreeDir: parsed.worktreeDir,
        projectRoot: parsed.projectRoot,
        stallTimeout: parsed.stallTimeout,
        issues,
        hooks: parsed.hooks,
        ...(parsed.defaultRepo && { defaultRepo: parsed.defaultRepo }),
        ...(parsed.defaultModel && { defaultModel: parsed.defaultModel }),
        ...(parsed.defaultEffort && { defaultEffort: parsed.defaultEffort }),
        ...(parsed.allowedTools && { allowedTools: parsed.allowedTools }),
        ...(parsed.issueComments && { issueComments: parsed.issueComments }),
        ...(parsed.labelSync && { labelSync: parsed.labelSync }),
        ...(parsed.retryOnCheckFailure && { retryOnCheckFailure: parsed.retryOnCheckFailure }),
    };
}
//# sourceMappingURL=schema.js.map