import { z } from "zod/v4";
/**
 * Zod schema for validating a parsed YAML orchestrator config.
 *
 * This validates the declarative YAML structure before hook derivation.
 * The downstream `validateConfig()` handles issue-graph validation
 * (duplicates, cycles, dangling refs).
 */
export declare const YamlConfigSchema: z.ZodObject<{
    name: z.ZodString;
    configDir: z.ZodString;
    worktreeDir: z.ZodString;
    projectRoot: z.ZodString;
    stallTimeout: z.ZodNumber;
    allowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    branchPrefix: z.ZodOptional<z.ZodString>;
    retryableStatuses: z.ZodOptional<z.ZodArray<z.ZodString>>;
    promptTemplate: z.ZodOptional<z.ZodString>;
    claudeArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    postSessionCheck: z.ZodOptional<z.ZodObject<{
        commands: z.ZodArray<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    summary: z.ZodOptional<z.ZodObject<{
        title: z.ZodString;
        columns: z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            width: z.ZodNumber;
            value: z.ZodString;
            prefix: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    issueComments: z.ZodOptional<z.ZodObject<{
        repo: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    labelSync: z.ZodOptional<z.ZodObject<{
        prefix: z.ZodString;
        repo: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    retryOnCheckFailure: z.ZodOptional<z.ZodObject<{
        maxRetries: z.ZodNumber;
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    baseBranch: z.ZodOptional<z.ZodString>;
    sequentialPaths: z.ZodOptional<z.ZodArray<z.ZodObject<{
        dir: z.ZodString;
        pattern: z.ZodString;
    }, z.core.$strip>>>;
    sequentialDomains: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        paths: z.ZodArray<z.ZodObject<{
            dir: z.ZodString;
            pattern: z.ZodString;
        }, z.core.$strip>>;
        width: z.ZodNumber;
    }, z.core.$strip>>>;
    issues: z.ZodArray<z.ZodObject<{
        number: z.ZodNumber;
        slug: z.ZodString;
        dependsOn: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
        description: z.ZodString;
        repo: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodString>;
        stallTimeout: z.ZodOptional<z.ZodNumber>;
        serial: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
