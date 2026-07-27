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
/**
 * Resolve the effective settings for the repo identified by `repoKey`
 * (`owner/repo`, typically `issue.repo ?? yaml.defaultRepo`). A `repoKey` of
 * `undefined`, or one absent from the `repos:` map, resolves to the top-level
 * defaults — which is exactly the single-repo behavior.
 */
export function resolveRepoSettings(yaml, repoKey) {
    const repo = repoKey ? yaml.repos?.[repoKey] : undefined;
    return {
        baseBranch: repo?.baseBranch ?? yaml.baseBranch ?? "main",
        postSessionCheck: repo?.postSessionCheck ?? yaml.postSessionCheck,
        sequentialPaths: repo?.sequentialPaths ?? yaml.sequentialPaths ?? [],
        appendableFiles: repo?.appendableFiles ?? yaml.appendableFiles ?? [],
    };
}
/**
 * The union of every appendable-file spec configured anywhere in the config —
 * top-level plus every repo entry — deduplicated by `path` (first occurrence
 * wins). Used by the repo-agnostic consumers (the `ownsFiles` exemption
 * allowlist and the merge-driver path lookup), which operate over the whole
 * config regardless of which repo owns a file.
 */
export function allAppendableFiles(yaml) {
    const seen = new Set();
    const out = [];
    const candidates = [
        ...(yaml.appendableFiles ?? []),
        ...Object.values(yaml.repos ?? {}).flatMap((r) => r.appendableFiles ?? []),
    ];
    for (const spec of candidates) {
        if (seen.has(spec.path))
            continue;
        seen.add(spec.path);
        out.push(spec);
    }
    return out;
}
/**
 * Keys in the `repos:` map that no issue references — neither via an issue's
 * own `repo` nor via `defaultRepo`. An unused key is almost always a typo
 * (e.g. a misspelled repo that silently leaves the real repo on the wrong base
 * branch), so callers surface these as a hard load-time error rather than
 * letting the override quietly not apply.
 */
export function unknownRepoKeys(yaml) {
    if (!yaml.repos)
        return [];
    const known = new Set();
    if (yaml.defaultRepo)
        known.add(yaml.defaultRepo);
    for (const issue of yaml.issues) {
        if (issue.repo)
            known.add(issue.repo);
    }
    return Object.keys(yaml.repos).filter((key) => !known.has(key));
}
//# sourceMappingURL=repo-settings.js.map