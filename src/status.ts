import fs from "node:fs";
import path from "node:path";
import type { Status, StatusStore, IssueMetadata, MetadataStore } from "./types.js";

export class InMemoryStatusStore implements StatusStore {
  private statuses = new Map<number, Status>();

  get(issueNumber: number): Status {
    return this.statuses.get(issueNumber) ?? "pending";
  }

  set(issueNumber: number, status: Status): void {
    this.statuses.set(issueNumber, status);
  }
}

export class FileStatusStore implements StatusStore {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  get(issueNumber: number): Status {
    const filePath = this.statusFilePath(issueNumber);
    try {
      return fs.readFileSync(filePath, "utf-8").trim() as Status;
    } catch {
      return "pending";
    }
  }

  set(issueNumber: number, status: Status): void {
    const dir = path.join(this.configDir, "status");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusFilePath(issueNumber), status);
  }

  private statusFilePath(issueNumber: number): string {
    return path.join(this.configDir, "status", `issue-${issueNumber}.status`);
  }
}

export class InMemoryMetadataStore implements MetadataStore {
  private metadata = new Map<number, IssueMetadata>();

  get(issueNumber: number): IssueMetadata {
    return this.metadata.get(issueNumber) ?? {};
  }

  set(issueNumber: number, metadata: IssueMetadata): void {
    this.metadata.set(issueNumber, metadata);
  }

  update(issueNumber: number, partial: Partial<IssueMetadata>): void {
    const current = this.get(issueNumber);
    this.metadata.set(issueNumber, { ...current, ...partial });
  }
}

export class FileMetadataStore implements MetadataStore {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  get(issueNumber: number): IssueMetadata {
    const filePath = this.metadataFilePath(issueNumber);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  set(issueNumber: number, metadata: IssueMetadata): void {
    const dir = path.join(this.configDir, "metadata");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.metadataFilePath(issueNumber), JSON.stringify(metadata, null, 2));
  }

  update(issueNumber: number, partial: Partial<IssueMetadata>): void {
    const current = this.get(issueNumber);
    this.set(issueNumber, { ...current, ...partial });
  }

  private metadataFilePath(issueNumber: number): string {
    return path.join(this.configDir, "metadata", `issue-${issueNumber}.json`);
  }
}
