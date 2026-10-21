import fs from "node:fs";
import path from "node:path";
import { encodeRefForFilename } from "./ref.js";
// Stores are keyed by issue ref ("owner/repo#N", or bare "N" when no repo is
// known). Filenames encode the ref reversibly; a bare-number ref encodes to
// itself, so existing single-repo state (`issue-<n>.status`) is read and
// written unchanged — no migration needed on upgrade.
export class InMemoryStatusStore {
    statuses = new Map();
    get(ref) {
        return this.statuses.get(ref) ?? "pending";
    }
    set(ref, status) {
        this.statuses.set(ref, status);
    }
    remove(ref) {
        this.statuses.delete(ref);
    }
}
export class FileStatusStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    get(ref) {
        const filePath = this.statusFilePath(ref);
        try {
            return fs.readFileSync(filePath, "utf-8").trim();
        }
        catch {
            return "pending";
        }
    }
    set(ref, status) {
        const dir = path.join(this.configDir, "status");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.statusFilePath(ref), status);
    }
    remove(ref) {
        try {
            fs.unlinkSync(this.statusFilePath(ref));
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    statusFilePath(ref) {
        return path.join(this.configDir, "status", `issue-${encodeRefForFilename(ref)}.status`);
    }
}
export class InMemoryMetadataStore {
    metadata = new Map();
    get(ref) {
        return this.metadata.get(ref) ?? {};
    }
    set(ref, metadata) {
        this.metadata.set(ref, metadata);
    }
    update(ref, partial) {
        const current = this.get(ref);
        this.metadata.set(ref, { ...current, ...partial });
    }
    remove(ref) {
        this.metadata.delete(ref);
    }
}
export class FileMetadataStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    get(ref) {
        const filePath = this.metadataFilePath(ref);
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
        catch {
            return {};
        }
    }
    set(ref, metadata) {
        const dir = path.join(this.configDir, "metadata");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.metadataFilePath(ref), JSON.stringify(metadata, null, 2));
    }
    update(ref, partial) {
        const current = this.get(ref);
        this.set(ref, { ...current, ...partial });
    }
    remove(ref) {
        try {
            fs.unlinkSync(this.metadataFilePath(ref));
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    metadataFilePath(ref) {
        return path.join(this.configDir, "metadata", `issue-${encodeRefForFilename(ref)}.json`);
    }
}
export class InMemoryDeathStore {
    deaths = new Map();
    append(ref, marker) {
        this.deaths.set(ref, [...(this.deaths.get(ref) ?? []), marker]);
    }
    list(ref) {
        return [...(this.deaths.get(ref) ?? [])];
    }
}
/** One JSONL file per ref under `<configDir>/deaths/`, only ever appended to. */
export class FileDeathStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    append(ref, marker) {
        fs.mkdirSync(path.join(this.configDir, "deaths"), { recursive: true });
        fs.appendFileSync(this.deathFilePath(ref), `${JSON.stringify(marker)}\n`);
    }
    list(ref) {
        let text;
        try {
            text = fs.readFileSync(this.deathFilePath(ref), "utf-8");
        }
        catch {
            return [];
        }
        const markers = [];
        for (const line of text.split("\n")) {
            try {
                if (line)
                    markers.push(JSON.parse(line));
            }
            catch {
                // A torn line must not hide the deaths around it.
            }
        }
        return markers;
    }
    deathFilePath(ref) {
        return path.join(this.configDir, "deaths", `issue-${encodeRefForFilename(ref)}.jsonl`);
    }
}
//# sourceMappingURL=status.js.map