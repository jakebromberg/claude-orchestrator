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
// ---------------------------------------------------------------------------
// Document navigation helpers
// ---------------------------------------------------------------------------
/**
 * Returns the array at `arrayPath` inside `doc`. `arrayPath` is a
 * dot-separated key path (e.g. `"entries"` or `"meta.entries"`).
 * Throws if the path does not resolve to an array.
 */
export function getNestedArray(doc, arrayPath) {
    const parts = arrayPath.split(".");
    let node = doc;
    for (const part of parts) {
        if (typeof node !== "object" || node === null) {
            throw new Error(`Cannot navigate path "${arrayPath}": expected object before "${part}" but got ${typeof node}`);
        }
        node = node[part];
    }
    if (!Array.isArray(node)) {
        throw new Error(`Path "${arrayPath}" does not point to an array (got ${Array.isArray(node) ? "array" : typeof node})`);
    }
    return node;
}
/**
 * Returns a shallow copy of `doc` with the array at `arrayPath` replaced by
 * `value`. Does not mutate `doc`.
 */
export function setNestedArray(doc, arrayPath, value) {
    const dotIdx = arrayPath.indexOf(".");
    if (dotIdx === -1) {
        return { ...doc, [arrayPath]: value };
    }
    const head = arrayPath.slice(0, dotIdx);
    const tail = arrayPath.slice(dotIdx + 1);
    const parent = doc;
    return {
        ...parent,
        [head]: setNestedArray(parent[head], tail, value),
    };
}
// ---------------------------------------------------------------------------
// Partial-text JSON extraction
// ---------------------------------------------------------------------------
/**
 * Extracts all complete JSON objects from `text` using a brace-depth counter.
 * This is intentionally lenient: conflict markers, trailing commas, and other
 * surrounding noise are silently skipped. Only balanced `{...}` blocks that
 * parse as valid JSON objects are returned.
 *
 * Used when the "theirs" or "ours" conflict section may contain partial object
 * text due to git splitting entries mid-line.
 */
export function extractJsonObjects(text) {
    const results = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\" && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === "{") {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (ch === "}") {
            depth--;
            if (depth === 0 && start !== -1) {
                const block = text.slice(start, i + 1);
                try {
                    const obj = JSON.parse(block);
                    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
                        results.push(obj);
                    }
                }
                catch {
                    // ignore non-parseable blocks
                }
                start = -1;
            }
        }
    }
    return results;
}
// ---------------------------------------------------------------------------
// Conflict marker parsing
// ---------------------------------------------------------------------------
const CONFLICT_START = "<<<<<<<";
const CONFLICT_MID = "=======";
const CONFLICT_END = ">>>>>>>";
/**
 * Parses the first git conflict block in `content` and returns the ours
 * section (between `<<<<<<<` and `=======`) and theirs section (between
 * `=======` and `>>>>>>>`). Returns `null` when no conflict markers are found.
 *
 * Only the first conflict block is considered; for journal files a single
 * conflict block is the expected shape.
 */
export function parseConflictSections(content) {
    const startIdx = content.indexOf(CONFLICT_START);
    const midIdx = content.indexOf(CONFLICT_MID);
    const endIdx = content.indexOf(CONFLICT_END);
    if (startIdx === -1 || midIdx === -1 || endIdx === -1)
        return null;
    if (!(startIdx < midIdx && midIdx < endIdx))
        return null;
    const oursStart = content.indexOf("\n", startIdx) + 1;
    const oursEnd = midIdx;
    const theirsStart = content.indexOf("\n", midIdx) + 1;
    const theirsEnd = endIdx;
    return {
        ours: content.slice(oursStart, oursEnd).trimEnd(),
        theirs: content.slice(theirsStart, theirsEnd).trimEnd(),
    };
}
// ---------------------------------------------------------------------------
// Array merge logic
// ---------------------------------------------------------------------------
function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
}
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
export function mergeJsonArrays(base, current, incoming, keyField) {
    const baseKeys = new Set(base.map((e) => e[keyField]));
    const currentAdded = current.filter((e) => !baseKeys.has(e[keyField]));
    const incomingAdded = incoming.filter((e) => !baseKeys.has(e[keyField]));
    const currentAddedKeys = new Set(currentAdded.map((e) => e[keyField]));
    const colliding = incomingAdded.find((e) => currentAddedKeys.has(e[keyField]));
    if (colliding) {
        throw new Error(`Collision on keyField "${keyField}" value ${JSON.stringify(colliding[keyField])}: ` +
            `both branches added an entry with this key`);
    }
    const merged = [...base, ...currentAdded, ...incomingAdded];
    merged.sort((a, b) => compareKeys(a[keyField], b[keyField]));
    return merged;
}
// ---------------------------------------------------------------------------
// Git merge driver entry point
// ---------------------------------------------------------------------------
/**
 * Merges three complete JSON document strings (no conflict markers).
 * Intended for use as a git merge driver where git provides clean ancestor,
 * ours, and theirs files.
 *
 * The merged document is derived from `current` with its array at `arrayPath`
 * replaced by the merged result.
 */
export function mergeJsonDocuments(base, current, incoming, config) {
    const baseDoc = JSON.parse(base);
    const currentDoc = JSON.parse(current);
    const incomingDoc = JSON.parse(incoming);
    const baseArr = getNestedArray(baseDoc, config.arrayPath);
    const currentArr = getNestedArray(currentDoc, config.arrayPath);
    const incomingArr = getNestedArray(incomingDoc, config.arrayPath);
    const merged = mergeJsonArrays(baseArr, currentArr, incomingArr, config.keyField);
    const mergedDoc = setNestedArray(currentDoc, config.arrayPath, merged);
    return JSON.stringify(mergedDoc, null, 2);
}
// ---------------------------------------------------------------------------
// Manual / post-conflict resolution
// ---------------------------------------------------------------------------
/**
 * Resolves a conflict-marked file using `baseContent` as the authoritative
 * ancestor. If no conflict markers are found, returns `conflictContent`
 * unchanged.
 *
 * Extracts JSON objects from the ours and theirs conflict sections using
 * `extractJsonObjects` (robust against partially-split objects), then merges
 * them against the base.
 */
export function resolveConflict(conflictContent, baseContent, config) {
    const sections = parseConflictSections(conflictContent);
    if (!sections)
        return conflictContent;
    const baseDoc = JSON.parse(baseContent);
    const baseArr = getNestedArray(baseDoc, config.arrayPath);
    const oursEntries = extractJsonObjects(sections.ours);
    const theirsEntries = extractJsonObjects(sections.theirs);
    const baseKeys = new Set(baseArr.map((e) => e[config.keyField]));
    const oursAdded = oursEntries.filter((e) => !baseKeys.has(e[config.keyField]));
    const theirsAdded = theirsEntries.filter((e) => !baseKeys.has(e[config.keyField]));
    const oursAddedKeys = new Set(oursAdded.map((e) => e[config.keyField]));
    const colliding = theirsAdded.find((e) => oursAddedKeys.has(e[config.keyField]));
    if (colliding) {
        throw new Error(`Collision on keyField "${config.keyField}" value ${JSON.stringify(colliding[config.keyField])}: ` +
            `both branches added an entry with this key`);
    }
    const merged = [...baseArr, ...oursAdded, ...theirsAdded];
    merged.sort((a, b) => compareKeys(a[config.keyField], b[config.keyField]));
    const mergedDoc = setNestedArray(baseDoc, config.arrayPath, merged);
    return JSON.stringify(mergedDoc, null, 2);
}
//# sourceMappingURL=merge-appendable.js.map