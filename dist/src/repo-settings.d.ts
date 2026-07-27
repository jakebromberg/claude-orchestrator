/**
 * Per-repo settings resolution for cross-repo DAGs.
 *
 * A single YAML config can span multiple repos (LML, Backend-Service, iOS,
 * canary). Each repo may need a different base branch (iOS forks from `master`,
 * others from `main`), a different CI/check profile, and its own sequential-file
 * collision domains. The `repos:` map holds those overrides keyed by
 * `owner/repo`; this module resolves the *effective* settings for a given repo
 * by layering a repo entry over the top-level defaults.
 *
 * Semantics: a repo override **replaces** the corresponding top-level field
 * wholesale (it is not deep-merged) — a repo's check profile or base branch is
 * its own, not a patch on the default. A repo that omits a field inherits the
 * top-level value for it.
 */
import type { YamlConfig, YamlPostSessionCheck, SequentialPathConfig, AppendableFileSpec } from "./yaml-types.js";
export interface ResolvedRepoSettings {
    /** Effective base branch: repo override → top-level → `"main"`. */
    baseBranch: string;
    /** Effective check profile, or `undefined` when none is configured. */
    postSessionCheck?: YamlPostSessionCheck;
    /** Effective collision domains (empty array when none). */
    sequentialPaths: SequentialPathConfig[];
    /** Effective appendable-file specs (empty array when none). */
    appendableFiles: AppendableFileSpec[];
}
/**
 * Resolve the effective settings for the repo identified by `repoKey`
 * (`owner/repo`, typically `issue.repo ?? yaml.defaultRepo`). A `repoKey` of
 * `undefined`, or one absent from the `repos:` map, resolves to the top-level
 * defaults — which is exactly the single-repo behavior.
 */
export declare function resolveRepoSettings(yaml: YamlConfig, repoKey: string | undefined): ResolvedRepoSettings;
/**
 * The union of every appendable-file spec configured anywhere in the config —
 * top-level plus every repo entry — deduplicated by `path`. Used by the
 * repo-agnostic consumers (the `ownsFiles` exemption allowlist and the
 * merge-driver path lookup), which key on `path` alone regardless of which repo
 * owns a file. Identical specs at the same path collapse to one; specs that
 * share a path but disagree on `format`/`arrayPath`/`keyField` throw, since the
 * path-keyed merge driver could otherwise apply one repo's merge rules to
 * another repo's file.
 */
export declare function allAppendableFiles(yaml: YamlConfig): AppendableFileSpec[];
/**
 * Keys in the `repos:` map that no issue references — neither via an issue's
 * own `repo` nor via `defaultRepo`. An unused key is almost always a typo
 * (e.g. a misspelled repo that silently leaves the real repo on the wrong base
 * branch), so callers surface these as a hard load-time error rather than
 * letting the override quietly not apply.
 */
export declare function unknownRepoKeys(yaml: YamlConfig): string[];
