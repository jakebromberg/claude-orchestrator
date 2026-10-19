import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspensionFile, writeSuspension, type SuspensionRecord } from "../src/suspensions.js";

const hooks = vi.hoisted(() => ({ beforeLink: () => {} }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, linkSync: (a: string, b: string) => (hooks.beforeLink(), real.linkSync(a, b)) };
});

const rec = (by: string): SuspensionRecord => ({ pgid: 4242, by, reason: "demo", at: "2026-10-16T12:00:00.000Z", remindAt: "2026-10-16T14:00:00.000Z", leader: null });

describe("writeSuspension under a race", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suspension-race-"));
  });
  afterEach(() => {
    hooks.beforeLink = () => {};
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses when a competitor lands its record after this writer's check, leaving the survivor intact and no temp file", () => {
    hooks.beforeLink = () => writeFileSync(suspensionFile(dir, 4242), JSON.stringify(rec("first")));
    expect(() => writeSuspension(dir, rec("second"))).toThrow(/already has a suspension record/);
    expect(JSON.parse(readFileSync(suspensionFile(dir, 4242), "utf-8")).by).toBe("first");
    expect(readdirSync(join(dir, "suspensions"))).toEqual(["4242.json"]);
  });

  it("lands the record complete at mode 0600 with no temp file left", () => {
    writeSuspension(dir, rec("only"));
    expect(JSON.parse(readFileSync(suspensionFile(dir, 4242), "utf-8"))).toEqual(rec("only"));
    expect(statSync(suspensionFile(dir, 4242)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "suspensions"))).toEqual(["4242.json"]);
  });
});
