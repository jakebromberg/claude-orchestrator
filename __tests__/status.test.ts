import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryStatusStore,
  FileStatusStore,
  InMemoryMetadataStore,
  FileMetadataStore,
} from "../src/status.js";

describe("InMemoryStatusStore", () => {
  let store: InMemoryStatusStore;

  beforeEach(() => {
    store = new InMemoryStatusStore();
  });

  it("returns 'pending' for unknown issues", () => {
    expect(store.get(99)).toBe("pending");
  });

  it("stores and retrieves a status", () => {
    store.set(1, "running");
    expect(store.get(1)).toBe("running");
  });

  it("overwrites a previous status", () => {
    store.set(1, "running");
    store.set(1, "succeeded");
    expect(store.get(1)).toBe("succeeded");
  });

  it("tracks multiple issues independently", () => {
    store.set(1, "running");
    store.set(2, "failed");
    expect(store.get(1)).toBe("running");
    expect(store.get(2)).toBe("failed");
    expect(store.get(3)).toBe("pending");
  });
});

describe("FileStatusStore", () => {
  let tmpDir: string;
  let store: FileStatusStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    store = new FileStatusStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'pending' when no file exists", () => {
    expect(store.get(42)).toBe("pending");
  });

  it("writes status to configDir/status/issue-N.status", () => {
    store.set(5, "running");
    const filePath = path.join(tmpDir, "status", "issue-5.status");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("running");
  });

  it("reads status back from file", () => {
    store.set(5, "succeeded");
    expect(store.get(5)).toBe("succeeded");
  });

  it("overwrites previous status", () => {
    store.set(5, "running");
    store.set(5, "failed");
    expect(store.get(5)).toBe("failed");
  });

  it("creates the status directory if it does not exist", () => {
    const statusDir = path.join(tmpDir, "status");
    expect(fs.existsSync(statusDir)).toBe(false);
    store.set(1, "running");
    expect(fs.existsSync(statusDir)).toBe(true);
  });
});

describe("InMemoryMetadataStore", () => {
  let store: InMemoryMetadataStore;

  beforeEach(() => {
    store = new InMemoryMetadataStore();
  });

  it("returns empty object for unknown issues", () => {
    expect(store.get(99)).toEqual({});
  });

  it("stores and retrieves metadata", () => {
    store.set(1, { prUrl: "https://github.com/org/repo/pull/10", prNumber: 10 });
    expect(store.get(1)).toEqual({ prUrl: "https://github.com/org/repo/pull/10", prNumber: 10 });
  });

  it("updates metadata by merging", () => {
    store.set(1, { exitCode: 0, startedAt: "2026-01-01T00:00:00Z" });
    store.update(1, { prUrl: "https://github.com/org/repo/pull/5" });
    expect(store.get(1)).toEqual({
      exitCode: 0,
      startedAt: "2026-01-01T00:00:00Z",
      prUrl: "https://github.com/org/repo/pull/5",
    });
  });

  it("overwrites existing fields on update", () => {
    store.set(1, { exitCode: 1 });
    store.update(1, { exitCode: 0 });
    expect(store.get(1).exitCode).toBe(0);
  });
});

describe("FileMetadataStore", () => {
  let tmpDir: string;
  let store: FileMetadataStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-meta-test-"));
    store = new FileMetadataStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when no file exists", () => {
    expect(store.get(42)).toEqual({});
  });

  it("writes metadata to configDir/metadata/issue-N.json", () => {
    store.set(5, { prUrl: "https://github.com/org/repo/pull/5", prNumber: 5 });
    const filePath = path.join(tmpDir, "metadata", "issue-5.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.prUrl).toBe("https://github.com/org/repo/pull/5");
  });

  it("reads metadata back from file", () => {
    store.set(5, { exitCode: 0 });
    expect(store.get(5)).toEqual({ exitCode: 0 });
  });

  it("merges on update", () => {
    store.set(5, { exitCode: 0, startedAt: "2026-01-01T00:00:00Z" });
    store.update(5, { prUrl: "https://github.com/org/repo/pull/5" });
    const meta = store.get(5);
    expect(meta.exitCode).toBe(0);
    expect(meta.prUrl).toBe("https://github.com/org/repo/pull/5");
  });

  it("creates the metadata directory if it does not exist", () => {
    const metaDir = path.join(tmpDir, "metadata");
    expect(fs.existsSync(metaDir)).toBe(false);
    store.set(1, { exitCode: 0 });
    expect(fs.existsSync(metaDir)).toBe(true);
  });
});
