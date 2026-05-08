import fs from "node:fs";
import path from "node:path";
export class InMemoryStatusStore {
    statuses = new Map();
    get(issueNumber) {
        return this.statuses.get(issueNumber) ?? "pending";
    }
    set(issueNumber, status) {
        this.statuses.set(issueNumber, status);
    }
    remove(issueNumber) {
        this.statuses.delete(issueNumber);
    }
}
export class FileStatusStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    get(issueNumber) {
        const filePath = this.statusFilePath(issueNumber);
        try {
            return fs.readFileSync(filePath, "utf-8").trim();
        }
        catch {
            return "pending";
        }
    }
    set(issueNumber, status) {
        const dir = path.join(this.configDir, "status");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.statusFilePath(issueNumber), status);
    }
    remove(issueNumber) {
        try {
            fs.unlinkSync(this.statusFilePath(issueNumber));
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    statusFilePath(issueNumber) {
        return path.join(this.configDir, "status", `issue-${issueNumber}.status`);
    }
}
export class InMemoryMetadataStore {
    metadata = new Map();
    get(issueNumber) {
        return this.metadata.get(issueNumber) ?? {};
    }
    set(issueNumber, metadata) {
        this.metadata.set(issueNumber, metadata);
    }
    update(issueNumber, partial) {
        const current = this.get(issueNumber);
        this.metadata.set(issueNumber, { ...current, ...partial });
    }
    remove(issueNumber) {
        this.metadata.delete(issueNumber);
    }
}
export class FileMetadataStore {
    configDir;
    constructor(configDir) {
        this.configDir = configDir;
    }
    get(issueNumber) {
        const filePath = this.metadataFilePath(issueNumber);
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
        catch {
            return {};
        }
    }
    set(issueNumber, metadata) {
        const dir = path.join(this.configDir, "metadata");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.metadataFilePath(issueNumber), JSON.stringify(metadata, null, 2));
    }
    update(issueNumber, partial) {
        const current = this.get(issueNumber);
        this.set(issueNumber, { ...current, ...partial });
    }
    remove(issueNumber) {
        try {
            fs.unlinkSync(this.metadataFilePath(issueNumber));
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    metadataFilePath(issueNumber) {
        return path.join(this.configDir, "metadata", `issue-${issueNumber}.json`);
    }
}
//# sourceMappingURL=status.js.map