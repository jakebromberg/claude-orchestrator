import { z } from "zod/v4";
import { computeWaves } from "./dag.js";
import type { OrchestratorConfig, RawOrchestratorConfig } from "./types.js";

const IssueSpecSchema = z.object({
  number: z.number().int().positive(),
  slug: z.string().min(1),
  dependsOn: z.array(z.number().int().positive()),
  description: z.string().min(1),
  repo: z.string().optional(),
  mode: z.string().optional(),
  stallTimeout: z.number().int().min(0).optional(),
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
  })
  .check((ctx) => {
    const issues = ctx.value.issues;
    const input = ctx.value;

    // Check for duplicate issue numbers
    const numbers = new Set<number>();
    for (const issue of issues) {
      if (numbers.has(issue.number)) {
        ctx.issues.push({
          code: "custom",
          input,
          message: `Duplicate issue number: #${issue.number}`,
          path: ["issues"],
        });
        return;
      }
      numbers.add(issue.number);
    }

    // Check for duplicate slugs
    const slugs = new Set<string>();
    for (const issue of issues) {
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

    // Check dependency references
    for (const issue of issues) {
      for (const dep of issue.dependsOn) {
        if (dep === issue.number) {
          ctx.issues.push({
            code: "custom",
            input,
            message: `Issue #${issue.number} has a self-referencing dependency`,
            path: ["issues"],
          });
          return;
        }
        if (!numbers.has(dep)) {
          ctx.issues.push({
            code: "custom",
            input,
            message: `Issue #${issue.number} depends on #${dep}, which does not exist`,
            path: ["issues"],
          });
          return;
        }
      }
    }

    // Check for cycles via computeWaves
    try {
      computeWaves(issues);
    } catch (err) {
      ctx.issues.push({
        code: "custom",
        input,
        message: (err as Error).message,
        path: ["issues"],
      });
    }
  });

/**
 * Validate a raw orchestrator config and compute wave assignments.
 *
 * Throws a ZodError if structural, referential, or graph validation fails.
 */
export function validateConfig(raw: RawOrchestratorConfig): OrchestratorConfig {
  const parsed = RawConfigSchema.parse(raw);
  const issues = computeWaves(parsed.issues);

  return {
    name: parsed.name,
    configDir: parsed.configDir,
    worktreeDir: parsed.worktreeDir,
    projectRoot: parsed.projectRoot,
    stallTimeout: parsed.stallTimeout,
    issues,
    hooks: parsed.hooks,
    ...(parsed.allowedTools && { allowedTools: parsed.allowedTools }),
  };
}
