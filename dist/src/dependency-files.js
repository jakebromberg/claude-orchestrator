/**
 * Collect files changed by upstream dependency issues.
 * Walks the issue's deps array and gathers filesChanged from their metadata.
 * Returns a deduplicated, sorted list of file paths.
 */
export function getDependencyFiles(issue, allIssues, getMetadata) {
    const files = new Set();
    for (const depRef of issue.deps) {
        const depMeta = getMetadata(depRef);
        if (depMeta.filesChanged) {
            for (const file of depMeta.filesChanged) {
                files.add(file);
            }
        }
    }
    return [...files].sort();
}
//# sourceMappingURL=dependency-files.js.map