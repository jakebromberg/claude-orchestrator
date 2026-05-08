/**
 * Journal-aware merge driver for append-only JSON array files.
 *
 * Provides pure merge functions used by the `claude-orchestrator-merge-appendable`
 * CLI command. The primary use case is Drizzle's `_journal.json`, but the logic
 * is general: any file that is a JSON document containing an array that grows
 * by appending unique keyed entries (e.g. migration indices, changelog entries).
 *
 * Two resolution modes are supported:
 *   1. Git merge driver mode — called by git with three clean file paths
 *      (`%O` base, `%A` ours, `%B` theirs). No conflict markers in any file.
 *      Use `mergeJsonDocuments`.
 *   2. Manual/post-conflict mode — user invokes on a file that already has
 *      git conflict markers. Use `resolveConflict` with a separate base string.
 */
/** Configuration for one appendable file. Declared in the YAML config. */
export interface AppendableFileConfig {
    /** Path to the file, relative to the project root. */
    path: string;
    /** File format. Currently only "json-array" is supported. */
    format: "json-array";
    /** Dot-separated path to the array within the document (e.g. `"entries"` or `"meta.entries"`). */
    arrayPath: string;
    /** Field whose value uniquely identifies each entry (e.g. `"idx"`). */
    keyField: string;
}
/**
 * Returns the array at `arrayPath` inside `doc`. `arrayPath` is a
 * dot-separated key path (e.g. `"entries"` or `"meta.entries"`).
 * Throws if the path does not resolve to an array.
 */
export declare function getNestedArray(doc: unknown, arrayPath: string): Record<string, unknown>[];
/**
 * Returns a shallow copy of `doc` with the array at `arrayPath` replaced by
 * `value`. Does not mutate `doc`.
 */
export declare function setNestedArray(doc: unknown, arrayPath: string, value: unknown[]): unknown;
/**
 * Extracts all complete JSON objects from `text` using a brace-depth counter.
 * This is intentionally lenient: conflict markers, trailing commas, and other
 * surrounding noise are silently skipped. Only balanced `{...}` blocks that
 * parse as valid JSON objects are returned.
 *
 * Used when the "theirs" or "ours" conflict section may contain partial object
 * text due to git splitting entries mid-line.
 */
export declare function extractJsonObjects(text: string): Record<string, unknown>[];
/**
 * Parses the first git conflict block in `content` and returns the ours
 * section (between `<<<<<<<` and `=======`) and theirs section (between
 * `=======` and `>>>>>>>`). Returns `null` when no conflict markers are found.
 *
 * Only the first conflict block is considered; for journal files a single
 * conflict block is the expected shape.
 */
export declare function parseConflictSections(content: string): {
    ours: string;
    theirs: string;
} | null;
/**
 * Merges three versions of an append-only array by `keyField`.
 *
 * Algorithm:
 *   - Determine what `current` added vs `base` (current-added).
 *   - Determine what `incoming` added vs `base` (incoming-added).
 *   - Throw if any key appears in both current-added and incoming-added
 *     (that is a real collision the claim system should have prevented).
 *   - Return base ∪ current-added ∪ incoming-added, sorted by keyField.
 */
export declare function mergeJsonArrays(base: Record<string, unknown>[], current: Record<string, unknown>[], incoming: Record<string, unknown>[], keyField: string): Record<string, unknown>[];
/**
 * Merges three complete JSON document strings (no conflict markers).
 * Intended for use as a git merge driver where git provides clean ancestor,
 * ours, and theirs files.
 *
 * The merged document is derived from `current` with its array at `arrayPath`
 * replaced by the merged result.
 */
export declare function mergeJsonDocuments(base: string, current: string, incoming: string, config: Pick<AppendableFileConfig, "arrayPath" | "keyField">): string;
/**
 * Resolves a conflict-marked file using `baseContent` as the authoritative
 * ancestor. If no conflict markers are found, returns `conflictContent`
 * unchanged.
 *
 * Extracts JSON objects from the ours and theirs conflict sections using
 * `extractJsonObjects` (robust against partially-split objects), then merges
 * them against the base.
 */
export declare function resolveConflict(conflictContent: string, baseContent: string, config: Pick<AppendableFileConfig, "arrayPath" | "keyField">): string;
