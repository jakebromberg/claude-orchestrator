/**
 * Cross-worktree collision detection for sequentially-numbered files.
 *
 * The pure `detectCollisions` function compares the set of files this branch
 * added against peer worktrees and the base branch since the merge-base, and
 * reports overlaps on the captured key (typically a zero-padded number such
 * as `0056`). The I/O wrapper `gatherCollisionInputs` runs the git diffs and
 * applies the per-entry regex to produce the structured input.
 */
import { shellQuote } from "./shell-quote.js";
export function detectCollisions(input) {
    const details = [];
    const nextSafeNumber = {};
    for (let entryIndex = 0; entryIndex < input.entries.length; entryIndex++) {
        const myFiles = input.current[entryIndex] ?? [];
        if (myFiles.length === 0) {
            nextSafeNumber[entryIndex] = computeNextSafe(entryIndex, input);
            continue;
        }
        for (const myFile of myFiles) {
            const peers = [];
            for (const [peerSlug, peerMap] of Object.entries(input.peers)) {
                for (const peerFile of peerMap[entryIndex] ?? []) {
                    if (peerFile.key === myFile.key) {
                        peers.push({ slug: peerSlug, path: peerFile.path });
                    }
                }
            }
            const shippedFiles = (input.shipped[entryIndex] ?? [])
                .filter((s) => s.key === myFile.key)
                .map((s) => s.path);
            if (peers.length > 0 || shippedFiles.length > 0) {
                details.push({
                    entryIndex,
                    key: myFile.key,
                    myFile: myFile.path,
                    peers,
                    shippedFiles,
                });
            }
        }
        nextSafeNumber[entryIndex] = computeNextSafe(entryIndex, input);
    }
    const collided = details.length > 0;
    const summary = renderSummary(details, nextSafeNumber, input.entries);
    const output = renderOutput(details, nextSafeNumber, input.entries);
    return { collided, details, summary, output, nextSafeNumber };
}
function computeNextSafe(entryIndex, input) {
    const observed = [];
    for (const file of input.current[entryIndex] ?? [])
        observed.push(file.key);
    for (const peer of Object.values(input.peers)) {
        for (const file of peer[entryIndex] ?? [])
            observed.push(file.key);
    }
    for (const file of input.shipped[entryIndex] ?? [])
        observed.push(file.key);
    if (observed.length === 0)
        return null;
    const numeric = observed
        .map((k) => ({ key: k, n: Number(k) }))
        .filter((x) => Number.isFinite(x.n) && /^\d+$/.test(x.key));
    if (numeric.length === 0)
        return null;
    const max = numeric.reduce((acc, x) => (x.n > acc.n ? x : acc), numeric[0]);
    const next = max.n + 1;
    const width = Math.max(...observed.filter((k) => /^\d+$/.test(k)).map((k) => k.length));
    return String(next).padStart(width, "0");
}
function renderSummary(details, nextSafeNumber, entries) {
    if (details.length === 0)
        return "No sequential-file collisions detected.";
    const lines = [];
    for (const d of details) {
        const dir = entries[d.entryIndex]?.dir ?? "<unknown>";
        const peerStr = d.peers
            .map((p) => `peer #${p.slug} (${p.path})`)
            .join(", ");
        const shippedStr = d.shippedFiles.length
            ? `origin (${d.shippedFiles.join(", ")})`
            : "";
        const sources = [peerStr, shippedStr].filter(Boolean).join(" and ");
        const next = nextSafeNumber[d.entryIndex];
        const hint = next ? ` Next safe number appears to be ${next}.` : "";
        lines.push(`Collision on ${dir} key ${d.key}: ${d.myFile} conflicts with ${sources}.${hint}`);
    }
    return lines.join(" ");
}
function renderOutput(details, nextSafeNumber, entries) {
    if (details.length === 0)
        return "";
    const lines = ["Sequential-file collision(s) detected:"];
    for (const d of details) {
        const dir = entries[d.entryIndex]?.dir ?? "<unknown>";
        lines.push(`- ${dir}: key ${d.key}`);
        lines.push(`    your file:     ${d.myFile}`);
        for (const p of d.peers) {
            lines.push(`    peer ${p.slug}:    ${p.path}`);
        }
        for (const s of d.shippedFiles) {
            lines.push(`    on origin:     ${s}`);
        }
        const next = nextSafeNumber[d.entryIndex];
        if (next)
            lines.push(`    next safe number: ${next}`);
    }
    return lines.join("\n");
}
export function gatherCollisionInputs(deps) {
    const { runCommand, existsSync, currentWorktree, peers, entries, baseBranch } = deps;
    const compiled = entries.map((e) => ({ entry: e, regex: new RegExp(e.pattern) }));
    // Best-effort fetch — never fail the scan because origin is unreachable.
    try {
        runCommand(`git -C ${shellQuote(currentWorktree)} fetch origin ${shellQuote(baseBranch)}`);
    }
    catch {
        // ignore — we proceed with whatever origin/<baseBranch> currently points to
    }
    const myMergeBase = safeMergeBase(runCommand, currentWorktree, baseBranch);
    const current = myMergeBase
        ? collectAddedByEntry(runCommand, currentWorktree, `${myMergeBase}..HEAD`, compiled)
        : {};
    const shipped = myMergeBase
        ? collectAddedByEntry(runCommand, currentWorktree, `${myMergeBase}..origin/${baseBranch}`, compiled)
        : {};
    const peersOut = {};
    for (const peer of peers) {
        if (!existsSync(peer.worktreePath))
            continue;
        try {
            const peerBase = runCommand(`git -C ${shellQuote(peer.worktreePath)} merge-base HEAD ${shellQuote(`origin/${baseBranch}`)}`).trim();
            if (!peerBase) {
                peersOut[peer.slug] = {};
                continue;
            }
            peersOut[peer.slug] = collectAddedByEntry(runCommand, peer.worktreePath, `${peerBase}..HEAD`, compiled, 
            /* throwOnError */ true);
        }
        catch (err) {
            deps.onPeerError?.(peer.slug, err instanceof Error ? err : new Error(String(err)));
            peersOut[peer.slug] = {};
        }
    }
    return { entries, current, peers: peersOut, shipped };
}
function safeMergeBase(runCommand, worktree, baseBranch) {
    try {
        const out = runCommand(`git -C ${shellQuote(worktree)} merge-base HEAD ${shellQuote(`origin/${baseBranch}`)}`);
        const sha = out.trim();
        return sha.length > 0 ? sha : null;
    }
    catch {
        return null;
    }
}
function collectAddedByEntry(runCommand, worktree, range, compiled, throwOnError = false) {
    const out = {};
    for (let i = 0; i < compiled.length; i++) {
        const { entry, regex } = compiled[i];
        let raw;
        try {
            raw = runCommand(`git -C ${shellQuote(worktree)} diff --diff-filter=A --find-renames --name-only ${shellQuote(range)} -- ${shellQuote(entry.dir)}`);
        }
        catch (err) {
            if (throwOnError)
                throw err;
            out[i] = [];
            continue;
        }
        const files = [];
        for (const line of raw.split("\n")) {
            const path = line.trim();
            if (!path)
                continue;
            const m = regex.exec(path);
            if (!m || m[1] == null)
                continue;
            files.push({ key: m[1], path });
        }
        out[i] = files;
    }
    return out;
}
//# sourceMappingURL=collision-check.js.map