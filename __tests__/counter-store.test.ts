import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCounterStore,
  FileCounterStore,
} from "../src/counter-store.js";

describe("InMemoryCounterStore", () => {
  let store: InMemoryCounterStore;

  beforeEach(() => {
    store = new InMemoryCounterStore();
  });

  it("seeds the domain on first claim and returns the seeded number", () => {
    const c = store.claim("migrations", 1, 4, () => 56);
    expect(c.number).toBe(56);
    expect(c.formatted).toBe("0056");
  });

  it("increments for the next distinct issue", () => {
    store.claim("migrations", 1, 4, () => 56);
    const c = store.claim("migrations", 2, 4, () => 999);
    expect(c.number).toBe(57);
    expect(c.formatted).toBe("0057");
  });

  it("returns the same number on a repeat claim from the same issue", () => {
    const first = store.claim("migrations", 1, 4, () => 56);
    const second = store.claim("migrations", 1, 4, () => 999);
    expect(second.number).toBe(first.number);
    expect(second.formatted).toBe(first.formatted);
  });

  it("does not call the seed function on subsequent claims", () => {
    let seedCalls = 0;
    const seed = () => {
      seedCalls++;
      return 56;
    };
    store.claim("migrations", 1, 4, seed);
    store.claim("migrations", 2, 4, seed);
    store.claim("migrations", 3, 4, seed);
    expect(seedCalls).toBe(1);
  });

  it("tracks domains independently", () => {
    const a = store.claim("migrations", 1, 4, () => 10);
    const b = store.claim("changelog", 1, 3, () => 200);
    expect(a.number).toBe(10);
    expect(a.formatted).toBe("0010");
    expect(b.number).toBe(200);
    expect(b.formatted).toBe("200");
  });

  it("formats with the requested width", () => {
    const c = store.claim("migrations", 1, 6, () => 7);
    expect(c.formatted).toBe("000007");
  });

  it("does not zero-pad when the number exceeds the width", () => {
    const c = store.claim("migrations", 1, 2, () => 1234);
    expect(c.formatted).toBe("1234");
  });
});

describe("FileCounterStore", () => {
  let tmpDir: string;
  let store: FileCounterStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-counter-"));
    store = new FileCounterStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seeds on first claim and persists to disk", () => {
    const c = store.claim("migrations", 1, 4, () => 56);
    expect(c.number).toBe(56);
    const file = path.join(tmpDir, "counters", "migrations.json");
    expect(fs.existsSync(file)).toBe(true);
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(state.claims["1"]).toBe(56);
  });

  it("increments across distinct issues", () => {
    store.claim("migrations", 1, 4, () => 56);
    const c = store.claim("migrations", 2, 4, () => 999);
    expect(c.number).toBe(57);
  });

  it("returns the same number on retry of the same issue", () => {
    const a = store.claim("migrations", 1, 4, () => 56);
    const b = store.claim("migrations", 1, 4, () => 999);
    expect(b.number).toBe(a.number);
  });

  it("survives a restart (new store instance reads existing file)", () => {
    store.claim("migrations", 1, 4, () => 56);
    const fresh = new FileCounterStore(tmpDir);
    const c = fresh.claim("migrations", 2, 4, () => 999);
    expect(c.number).toBe(57);
  });

  it("creates the counters directory if missing", () => {
    expect(fs.existsSync(path.join(tmpDir, "counters"))).toBe(false);
    store.claim("migrations", 1, 4, () => 56);
    expect(fs.existsSync(path.join(tmpDir, "counters"))).toBe(true);
  });

  it("isolates domains in separate files", () => {
    store.claim("migrations", 1, 4, () => 56);
    store.claim("changelog", 1, 3, () => 200);
    expect(
      fs.existsSync(path.join(tmpDir, "counters", "migrations.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "counters", "changelog.json")),
    ).toBe(true);
  });

  it("rejects domain names that contain path separators", () => {
    expect(() => store.claim("foo/bar", 1, 4, () => 1)).toThrow();
    expect(() => store.claim("../escape", 1, 4, () => 1)).toThrow();
  });
});

describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../src/counter-store.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
