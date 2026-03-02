import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { YamlConfigSchema } from "./yaml-schema.js";
import { deriveHooks } from "./yaml-hooks.js";
import { validateConfig } from "./schema.js";
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
export async function loadYamlConfig(yamlPath, options = {}) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    // Validate YAML structure
    const yaml = YamlConfigSchema.parse(parsed);
    // Resolve relative paths against the YAML file's directory
    const yamlDir = path.dirname(yamlPath);
    yaml.configDir = path.resolve(yamlDir, yaml.configDir);
    yaml.worktreeDir = path.resolve(yamlDir, yaml.worktreeDir);
    yaml.projectRoot = path.resolve(yamlDir, yaml.projectRoot);
    if (yaml.promptTemplate) {
        yaml.promptTemplate = path.resolve(yamlDir, yaml.promptTemplate);
    }
    // Derive hooks from YAML fields
    const derivedHooks = deriveHooks(yaml);
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
    });
}
//# sourceMappingURL=yaml-loader.js.map