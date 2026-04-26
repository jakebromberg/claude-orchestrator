import { z } from "zod/v4";

const YamlIssueSchema = z.object({
  number: z.number().int().positive(),
  slug: z.string().min(1),
  dependsOn: z.array(z.number().int().positive()).default([]),
  description: z.string().min(1),
  repo: z.string().optional(),
  mode: z.string().optional(),
  stallTimeout: z.number().int().min(0).optional(),
  serial: z.boolean().optional(),
});

const YamlSummaryColumnSchema = z.object({
  header: z.string().min(1),
  width: z.number().int().positive(),
  value: z.string().min(1),
  prefix: z.string().optional(),
});

const YamlSummarySchema = z.object({
  title: z.string().min(1),
  columns: z.array(YamlSummaryColumnSchema).min(1),
});

const YamlPostSessionCheckSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
});

const SequentialPathConfigSchema = z.object({
  dir: z.string().min(1),
  pattern: z
    .string()
    .min(1)
    .refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: "pattern must be a valid regular expression" },
    )
    .refine(
      (p) => {
        // Capture groups: count "(" that are not "(?" and not escaped "\(".
        const stripped = p.replace(/\\\\/g, "").replace(/\\\(/g, "").replace(/\(\?/g, "");
        return stripped.includes("(");
      },
      { message: "pattern must contain at least one capture group" },
    ),
});

/**
 * Zod schema for validating a parsed YAML orchestrator config.
 *
 * This validates the declarative YAML structure before hook derivation.
 * The downstream `validateConfig()` handles issue-graph validation
 * (duplicates, cycles, dangling refs).
 */
export const YamlConfigSchema = z.object({
  name: z.string().min(1),
  configDir: z.string().min(1),
  worktreeDir: z.string().min(1),
  projectRoot: z.string().min(1),
  stallTimeout: z.number().int().min(0),
  allowedTools: z.array(z.string()).optional(),

  branchPrefix: z.string().optional(),
  retryableStatuses: z.array(z.string()).optional(),
  promptTemplate: z.string().optional(),
  claudeArgs: z.array(z.string()).optional(),
  postSessionCheck: YamlPostSessionCheckSchema.optional(),
  summary: YamlSummarySchema.optional(),
  issueComments: z.object({ repo: z.string(), enabled: z.boolean().optional() }).optional(),
  labelSync: z.object({ prefix: z.string(), repo: z.string().optional() }).optional(),
  retryOnCheckFailure: z.object({ maxRetries: z.number().int().positive(), enabled: z.boolean().optional() }).optional(),
  baseBranch: z.string().min(1).optional(),
  sequentialPaths: z.array(SequentialPathConfigSchema).optional(),
  issues: z.array(YamlIssueSchema),
});
