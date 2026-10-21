import type { Status, StatusStore, IssueMetadata, MetadataStore, DeathMarker, DeathStore } from "./types.js";
export declare class InMemoryStatusStore implements StatusStore {
    private statuses;
    get(ref: string): Status;
    set(ref: string, status: Status): void;
    remove(ref: string): void;
}
export declare class FileStatusStore implements StatusStore {
    private configDir;
    constructor(configDir: string);
    get(ref: string): Status;
    set(ref: string, status: Status): void;
    remove(ref: string): void;
    private statusFilePath;
}
export declare class InMemoryMetadataStore implements MetadataStore {
    private metadata;
    get(ref: string): IssueMetadata;
    set(ref: string, metadata: IssueMetadata): void;
    update(ref: string, partial: Partial<IssueMetadata>): void;
    remove(ref: string): void;
}
export declare class FileMetadataStore implements MetadataStore {
    private configDir;
    constructor(configDir: string);
    get(ref: string): IssueMetadata;
    set(ref: string, metadata: IssueMetadata): void;
    update(ref: string, partial: Partial<IssueMetadata>): void;
    remove(ref: string): void;
    private metadataFilePath;
}
export declare class InMemoryDeathStore implements DeathStore {
    private deaths;
    append(ref: string, marker: DeathMarker): void;
    list(ref: string): DeathMarker[];
}
/** One JSONL file per ref under `<configDir>/deaths/`, only ever appended to. */
export declare class FileDeathStore implements DeathStore {
    private configDir;
    constructor(configDir: string);
    append(ref: string, marker: DeathMarker): void;
    list(ref: string): DeathMarker[];
    private deathFilePath;
}
