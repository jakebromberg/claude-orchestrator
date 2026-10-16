import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEngineRegistry } from "../src/engine-registry.js";

vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: vi.fn() }));

const info = { runId: "run-1", logDir: "/tmp/c/logs", stallTimeout: 1800 };

describe("createFileEngineRegistry", () => {
  let dir: string;
  const file = () => join(dir, "engines", "4242.json");
  const read = () => JSON.parse(readFileSync(file(), "utf-8"));
  const make = (over: Partial<Parameters<typeof createFileEngineRegistry>[0]> = {}) =>
    createFileEngineRegistry({ dir, pid: 4242, pgid: () => 4000, now: () => new Date("2026-10-16T12:00:00Z"), ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-engine-registry-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the record at start and removes it at stop", () => {
    const registry = make();
    registry.start(info);
    expect(read()).toEqual({ pid: 4242, pgid: 4000, ...info, startedAt: "2026-10-16T12:00:00.000Z" });

    registry.stop();
    expect(existsSync(file())).toBe(false);
  });

  it("rewrites the record every 30 s and stops refreshing after stop", () => {
    const registry = make();
    registry.start(info);
    rmSync(file());

    vi.advanceTimersByTime(30_000);
    expect(existsSync(file())).toBe(true);

    registry.stop();
    vi.advanceTimersByTime(60_000);
    expect(existsSync(file())).toBe(false);
  });

  it("does not keep the process alive", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const registry = make();
    registry.start(info);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    registry.stop();
  });

  it("records a null pgid when it cannot be read", () => {
    make({ pgid: () => { throw new Error("no ps"); } }).start(info);
    expect(read().pgid).toBeNull();
  });

  it("swallows a write failure", () => {
    chmodSync(dir, 0o500);
    try {
      expect(() => make().start(info)).not.toThrow();
      expect(existsSync(join(dir, "engines"))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  describe("the lease's directory rule", () => {
    const mode = (p: string) => statSync(p).mode & 0o777;

    it.each([
      ["creates engines/ at 0700", (_d: string) => {}, (d: string) => mode(join(d, "engines")) === 0o700],
      ["tightens an existing engines/ to 0700", (d: string) => { mkdirSync(join(d, "engines"), { mode: 0o755 }); chmodSync(join(d, "engines"), 0o755); }, (d: string) => mode(join(d, "engines")) === 0o700],
      ["tightens an existing lease directory to 0700", (d: string) => chmodSync(d, 0o755), (d: string) => mode(d) === 0o700],
    ])("%s", (_name, arrange, ok) => {
      arrange(dir);
      make().start(info);
      expect(ok(dir)).toBe(true);
      expect(read().pid).toBe(4242);
    });

    it("creates a missing lease directory at 0700", () => {
      const missing = join(dir, "lease");
      make({ dir: missing }).start(info);
      expect(mode(missing)).toBe(0o700);
      expect(mode(join(missing, "engines"))).toBe(0o700);
      expect(existsSync(join(missing, "engines", "4242.json"))).toBe(true);
    });

    it.each([
      ["a symlink", (target: string, link: string) => symlinkSync(target, link)],
      ["not a directory", (_target: string, link: string) => writeFileSync(link, "x")],
    ])("refuses engines/ that is %s, writes nothing through it and does not throw", (_name, plant) => {
      const target = mkdtempSync(join(tmpdir(), "co-engine-target-"));
      try {
        plant(target, join(dir, "engines"));
        expect(() => make().start(info)).not.toThrow();
        expect(readdirSync(target)).toEqual([]);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });

  it("swallows a remove failure", () => {
    const registry = make();
    registry.start(info);
    chmodSync(join(dir, "engines"), 0o500);
    try {
      expect(() => registry.stop()).not.toThrow();
      expect(existsSync(file())).toBe(true); // the unlink really failed
    } finally {
      chmodSync(join(dir, "engines"), 0o700);
    }
  });

  it("writes atomically with mode 0600 and leaves no temp file", () => {
    const registry = make();
    registry.start(info);
    vi.advanceTimersByTime(30_000);
    expect(readdirSync(join(dir, "engines"))).toEqual(["4242.json"]);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    registry.stop();
  });

  describe("default pgid reader", () => {
    const ps = vi.mocked(execFileSync);
    const startDefault = () => createFileEngineRegistry({ dir, pid: 4242 }).start(info);

    it("runs ps with a 2 s timeout and ignored stderr", () => {
      ps.mockReturnValueOnce("  4000\n");
      startDefault();
      expect(read().pgid).toBe(4000);
      expect(ps).toHaveBeenCalledWith("ps", ["-o", "pgid=", "-p", "4242"], expect.objectContaining({ timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }));
    });

    it.each([["throws", () => { throw new Error("timed out"); }], ["prints garbage", () => "oops"]])("records a null pgid when ps %s", (_n, impl) => {
      ps.mockImplementationOnce(impl as () => string);
      startDefault();
      expect(read().pgid).toBeNull();
    });
  });
});
