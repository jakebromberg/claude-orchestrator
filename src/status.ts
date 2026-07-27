import fs from "node:fs";
import path from "node:path";
import type { Status, StatusStore, IssueMetadata, MetadataStore } from "./types.js";
import { encodeRefForFilename } from "./ref.js";

// Stores are keyed by issue ref ("owner/repo#N", or bare "N" when no repo is
// known). Filenames encode the ref reversibly; a bare-number ref encodes to
// itself, so existing single-repo state (`issue-<n>.status`) is read and
// written unchanged — no migration needed on upgrade.

export class InMemoryStatusStore implements StatusStore {
  private statuses = new Map<string, Status>();

  get(ref: string): Status {
    return this.statuses.get(ref) ?? "pending";
  }

  set(ref: string, status: Status): void {
    this.statuses.set(ref, status);
  }

  remove(ref: string): void {
    this.statuses.delete(ref);
  }
}

export class FileStatusStore implements StatusStore {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  get(ref: string): Status {
    const filePath = this.statusFilePath(ref);
    try {
      return fs.readFileSync(filePath, "utf-8").trim() as Status;
    } catch {
      return "pending";
    }
  }

  set(ref: string, status: Status): void {
    const dir = path.join(this.configDir, "status");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusFilePath(ref), status);
  }

  remove(ref: string): void {
    try {
      fs.unlinkSync(this.statusFilePath(ref));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private statusFilePath(ref: string): string {
    return path.join(this.configDir, "status", `issue-${encodeRefForFilename(ref)}.status`);
  }
}

export class InMemoryMetadataStore implements MetadataStore {
  private metadata = new Map<string, IssueMetadata>();

  get(ref: string): IssueMetadata {
    return this.metadata.get(ref) ?? {};
  }

  set(ref: string, metadata: IssueMetadata): void {
    this.metadata.set(ref, metadata);
  }

  update(ref: string, partial: Partial<IssueMetadata>): void {
    const current = this.get(ref);
    this.metadata.set(ref, { ...current, ...partial });
  }

  remove(ref: string): void {
    this.metadata.delete(ref);
  }
}

export class FileMetadataStore implements MetadataStore {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  get(ref: string): IssueMetadata {
    const filePath = this.metadataFilePath(ref);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  set(ref: string, metadata: IssueMetadata): void {
    const dir = path.join(this.configDir, "metadata");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.metadataFilePath(ref), JSON.stringify(metadata, null, 2));
  }

  update(ref: string, partial: Partial<IssueMetadata>): void {
    const current = this.get(ref);
    this.set(ref, { ...current, ...partial });
  }

  remove(ref: string): void {
    try {
      fs.unlinkSync(this.metadataFilePath(ref));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private metadataFilePath(ref: string): string {
    return path.join(this.configDir, "metadata", `issue-${encodeRefForFilename(ref)}.json`);
  }
}
