import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { YamlConfigSchema } from "./yaml-schema.js";
import { deriveHooks } from "./yaml-hooks.js";
import { validateConfig } from "./schema.js";
import type { OrchestratorConfig } from "./types.js";
import type { HooksOverride, YamlConfig } from "./yaml-types.js";

export interface LoadYamlConfigOptions {
  /** Hook overrides to merge on top of derived hooks. */
  hooksOverride?: HooksOverride;
}

/**
 * Resolve all relative path fields on a parsed `YamlConfig` against the
 * YAML file's directory. Mutates `yaml` in place. Used by `loadYamlConfig`
 * and the standalone `cli-claim` entry point so both apply identical
 * resolution and don't drift.
 */
export function resolveYamlPaths(yaml: YamlConfig, yamlDir: string): void {
  yaml.configDir = path.resolve(yamlDir, yaml.configDir);
  yaml.worktreeDir = path.resolve(yamlDir, yaml.worktreeDir);
  yaml.projectRoot = path.resolve(yamlDir, yaml.projectRoot);
  if (yaml.promptTemplate) {
    yaml.promptTemplate = path.resolve(yamlDir, yaml.promptTemplate);
  }
}

/**
 * Load an orchestrator config from a YAML file.
 *
 * 1. Reads and parses the YAML file
 * 2. Validates against `YamlConfigSchema`
 * 3. Resolves relative paths against the YAML file's directory
 * 4. Derives hooks from YAML fields
 * 5. Merges optional `.hooks.ts` overrides
 * 6. Runs `validateConfig()` (issue graph validation + wave assignment)
 *
 * @param yamlPath - Absolute path to the YAML config file.
 * @param options  - Optional hook overrides.
 */
export async function loadYamlConfig(
  yamlPath: string,
  options: LoadYamlConfigOptions = {},
): Promise<OrchestratorConfig> {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw);

  // Validate YAML structure
  const yaml = YamlConfigSchema.parse(parsed) as YamlConfig;

  // Resolve relative paths against the YAML file's directory
  resolveYamlPaths(yaml, path.dirname(yamlPath));

  // Derive hooks from YAML fields. `yamlPath` is threaded through so the
  // {{CLAIM_NUMBER}} prompt variable can reference this exact config file.
  // `readFile` is wired to `fs.readFileSync` via the default-import namespace
  // so tests can intercept prompt-template loading with
  // `vi.spyOn(fs, "readFileSync")` (the spy modifies the namespace property
  // but not named-import bindings, so deriveHooks can't reach it through its
  // own `import { readFileSync } from "node:fs"`).
  const derivedHooks = deriveHooks(yaml, {
    yamlPath: path.resolve(yamlPath),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  });

  // Merge overrides (overrides take precedence)
  const hooks = options.hooksOverride
    ? { ...derivedHooks, ...options.hooksOverride }
    : derivedHooks;

  // Build raw config and validate (computes waves, checks graph)
  return validateConfig({
    name: yaml.name,
    configDir: yaml.configDir,
    worktreeDir: yaml.worktreeDir,
    projectRoot: yaml.projectRoot,
    stallTimeout: yaml.stallTimeout,
    issues: yaml.issues,
    hooks,
    ...(yaml.allowedTools && { allowedTools: yaml.allowedTools }),
    ...(yaml.issueComments && { issueComments: { repo: yaml.issueComments.repo, enabled: yaml.issueComments.enabled ?? true } }),
    ...(yaml.labelSync && { labelSync: yaml.labelSync }),
    ...(yaml.retryOnCheckFailure && { retryOnCheckFailure: { maxRetries: yaml.retryOnCheckFailure.maxRetries, enabled: yaml.retryOnCheckFailure.enabled ?? true } }),
  });
}
