import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { YamlConfigSchema } from "./yaml-schema.js";
import { deriveHooks } from "./yaml-hooks.js";
import { allAppendableFiles, unknownRepoKeys } from "./repo-settings.js";
import { validateConfig } from "./schema.js";
/**
 * Resolve all relative path fields on a parsed `YamlConfig` against the
 * YAML file's directory. Mutates `yaml` in place. Used by `loadYamlConfig`
 * and the standalone `cli-claim` entry point so both apply identical
 * resolution and don't drift.
 */
export function resolveYamlPaths(yaml, yamlDir) {
    yaml.configDir = path.resolve(yamlDir, yaml.configDir);
    yaml.worktreeDir = path.resolve(yamlDir, yaml.worktreeDir);
    yaml.projectRoot = path.resolve(yamlDir, yaml.projectRoot);
    if (yaml.promptTemplate) {
        yaml.promptTemplate = path.resolve(yamlDir, yaml.promptTemplate);
    }
    // Per-issue extra read dirs (`--add-dir`) are paths like other config paths —
    // resolve any relative entry against the YAML file's directory so they don't
    // silently resolve against each worktree's cwd at spawn time.
    for (const issue of yaml.issues) {
        if (issue.extraDirs) {
            issue.extraDirs = issue.extraDirs.map((dir) => path.resolve(yamlDir, dir));
        }
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
export async function loadYamlConfig(yamlPath, options = {}) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    // Validate YAML structure
    const yaml = YamlConfigSchema.parse(parsed);
    // Resolve relative paths against the YAML file's directory
    resolveYamlPaths(yaml, path.dirname(yamlPath));
    // Guard against typo'd `repos:` keys. An unused key silently leaves the real
    // repo on the top-level defaults (e.g. `main` instead of `master`) — exactly
    // the mistake per-repo settings exist to prevent — so fail loud at load.
    const unknown = unknownRepoKeys(yaml);
    if (unknown.length > 0) {
        throw new Error(`repos: map has ${unknown.length} key(s) not referenced by any issue's ` +
            `repo or defaultRepo: ${unknown.join(", ")}. ` +
            `Remove them or fix the spelling.`);
    }
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
    // Files that are safe to overlap across parallel issues: explicit allowlist
    // plus any appendableFiles paths (handled mechanically by the merge driver).
    const ignoredOwnsFiles = [
        ...(yaml.sharedFiles ?? []),
        ...allAppendableFiles(yaml).map((f) => f.path),
    ];
    // Build raw config and validate (computes waves, checks graph)
    return validateConfig({
        name: yaml.name,
        configDir: yaml.configDir,
        worktreeDir: yaml.worktreeDir,
        projectRoot: yaml.projectRoot,
        stallTimeout: yaml.stallTimeout,
        issues: yaml.issues,
        hooks,
        ...(yaml.defaultRepo && { defaultRepo: yaml.defaultRepo }),
        ...(yaml.defaultModel && { defaultModel: yaml.defaultModel }),
        ...(yaml.defaultEffort && { defaultEffort: yaml.defaultEffort }),
        ...(yaml.allowedTools && { allowedTools: yaml.allowedTools }),
        ...(yaml.issueComments && { issueComments: { repo: yaml.issueComments.repo, enabled: yaml.issueComments.enabled ?? true } }),
        ...(yaml.labelSync && { labelSync: yaml.labelSync }),
        ...(yaml.retryOnCheckFailure && { retryOnCheckFailure: { maxRetries: yaml.retryOnCheckFailure.maxRetries, enabled: yaml.retryOnCheckFailure.enabled ?? true } }),
    }, ignoredOwnsFiles.length > 0 ? { ignoredOwnsFiles } : undefined);
}
//# sourceMappingURL=yaml-loader.js.map