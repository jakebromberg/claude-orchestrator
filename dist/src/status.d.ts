import type { Status, StatusStore, IssueMetadata, MetadataStore } from "./types.js";
export declare class InMemoryStatusStore implements StatusStore {
    private statuses;
    get(issueNumber: number): Status;
    set(issueNumber: number, status: Status): void;
}
export declare class FileStatusStore implements StatusStore {
    private configDir;
    constructor(configDir: string);
    get(issueNumber: number): Status;
    set(issueNumber: number, status: Status): void;
    private statusFilePath;
}
export declare class InMemoryMetadataStore implements MetadataStore {
    private metadata;
    get(issueNumber: number): IssueMetadata;
    set(issueNumber: number, metadata: IssueMetadata): void;
    update(issueNumber: number, partial: Partial<IssueMetadata>): void;
}
export declare class FileMetadataStore implements MetadataStore {
    private configDir;
    constructor(configDir: string);
    get(issueNumber: number): IssueMetadata;
    set(issueNumber: number, metadata: IssueMetadata): void;
    update(issueNumber: number, partial: Partial<IssueMetadata>): void;
    private metadataFilePath;
}
