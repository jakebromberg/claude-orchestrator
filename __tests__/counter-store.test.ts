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
    expect(store.claim("migrations", 1, () => 56)).toBe(56);
  });

  it("increments for the next distinct issue", () => {
    store.claim("migrations", 1, () => 56);
    expect(store.claim("migrations", 2, () => 999)).toBe(57);
  });

  it("returns the same number on a repeat claim from the same issue", () => {
    const first = store.claim("migrations", 1, () => 56);
    const second = store.claim("migrations", 1, () => 999);
    expect(second).toBe(first);
  });

  it("does not call the seed function on subsequent claims", () => {
    let seedCalls = 0;
    const seed = () => {
      seedCalls++;
      return 56;
    };
    store.claim("migrations", 1, seed);
    store.claim("migrations", 2, seed);
    store.claim("migrations", 3, seed);
    expect(seedCalls).toBe(1);
  });

  it("tracks domains independently", () => {
    expect(store.claim("migrations", 1, () => 10)).toBe(10);
    expect(store.claim("changelog", 1, () => 200)).toBe(200);
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
    expect(store.claim("migrations", 1, () => 56)).toBe(56);
    const file = path.join(tmpDir, "counters", "migrations.json");
    expect(fs.existsSync(file)).toBe(true);
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(state.claims["1"]).toBe(56);
  });

  it("increments across distinct issues", () => {
    store.claim("migrations", 1, () => 56);
    expect(store.claim("migrations", 2, () => 999)).toBe(57);
  });

  it("returns the same number on retry of the same issue", () => {
    const a = store.claim("migrations", 1, () => 56);
    const b = store.claim("migrations", 1, () => 999);
    expect(b).toBe(a);
  });

  it("survives a restart (new store instance reads existing file)", () => {
    store.claim("migrations", 1, () => 56);
    const fresh = new FileCounterStore(tmpDir);
    expect(fresh.claim("migrations", 2, () => 999)).toBe(57);
  });

  it("creates the counters directory if missing", () => {
    expect(fs.existsSync(path.join(tmpDir, "counters"))).toBe(false);
    store.claim("migrations", 1, () => 56);
    expect(fs.existsSync(path.join(tmpDir, "counters"))).toBe(true);
  });

  it("isolates domains in separate files", () => {
    store.claim("migrations", 1, () => 56);
    store.claim("changelog", 1, () => 200);
    expect(
      fs.existsSync(path.join(tmpDir, "counters", "migrations.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "counters", "changelog.json")),
    ).toBe(true);
  });

  it("rejects domain names that contain path separators", () => {
    expect(() => store.claim("foo/bar", 1, () => 1)).toThrow();
    expect(() => store.claim("../escape", 1, () => 1)).toThrow();
  });

  it("releases the lock file after a successful claim", () => {
    store.claim("migrations", 1, () => 56);
    const lock = path.join(tmpDir, "counters", "migrations.json.lock");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("releases the lock file even when the seed function throws", () => {
    expect(() =>
      store.claim("migrations", 1, () => {
        throw new Error("seed boom");
      }),
    ).toThrow(/seed boom/);
    const lock = path.join(tmpDir, "counters", "migrations.json.lock");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reaps a stale lock from a dead PID and proceeds", () => {
    // Seed a lockfile with a PID that's overwhelmingly unlikely to exist.
    // (PID 0x7FFFFFFE is reserved as PID_MAX on Linux/macOS, and not used.)
    fs.mkdirSync(path.join(tmpDir, "counters"), { recursive: true });
    const lock = path.join(tmpDir, "counters", "migrations.json.lock");
    fs.writeFileSync(lock, "2147483646");
    expect(store.claim("migrations", 1, () => 56)).toBe(56);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("does not reap a lock held by a live PID and times out", () => {
    const fastStore = new FileCounterStore(tmpDir, { lockTimeoutMs: 200 });
    fs.mkdirSync(path.join(tmpDir, "counters"), { recursive: true });
    const lock = path.join(tmpDir, "counters", "migrations.json.lock");
    fs.writeFileSync(lock, String(process.pid));
    try {
      expect(() =>
        fastStore.claim("migrations", 1, () => 56),
      ).toThrow(/Timed out waiting for counter lock/);
    } finally {
      fs.unlinkSync(lock);
    }
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
