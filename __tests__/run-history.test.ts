import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRunRecord, listRuns } from "../src/run-history.js";
import type { RunRecord } from "../src/types.js";

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "2026-02-26T10-30-00.000Z",
    configName: "test-orchestrator",
    mode: "run-all",
    startedAt: "2026-02-26T10:30:00.000Z",
    finishedAt: "2026-02-26T10:35:00.000Z",
    durationSeconds: 300,
    maxParallel: 4,
    statuses: { 1: "succeeded", 2: "failed", 3: "pending" },
    ...overrides,
  };
}

describe("writeRunRecord", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates configDir/runs/ directory if it does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const runsDir = path.join(tmpDir, "runs");
    expect(fs.existsSync(runsDir)).toBe(false);

    writeRunRecord(tmpDir, makeRecord());

    expect(fs.existsSync(runsDir)).toBe(true);
  });

  it("writes a JSON file named after the record id", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const record = makeRecord({ id: "2026-02-26T10-30-00.000Z" });

    writeRunRecord(tmpDir, record);

    const filePath = path.join(tmpDir, "runs", "2026-02-26T10-30-00.000Z.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("file content round-trips through JSON.parse", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const record = makeRecord();

    writeRunRecord(tmpDir, record);

    const filePath = path.join(tmpDir, "runs", `${record.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual(record);
  });

  it("preserves optional fields when present", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const record = makeRecord({ wave: 2, targetIssues: [1, 3] });

    writeRunRecord(tmpDir, record);

    const filePath = path.join(tmpDir, "runs", `${record.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.wave).toBe(2);
    expect(parsed.targetIssues).toEqual([1, 3]);
  });
});

describe("listRuns", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when runs/ directory does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    expect(listRuns(tmpDir)).toEqual([]);
  });

  it("returns empty array when runs/ directory is empty", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    fs.mkdirSync(path.join(tmpDir, "runs"));
    expect(listRuns(tmpDir)).toEqual([]);
  });

  it("returns records sorted by startedAt ascending", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const later = makeRecord({
      id: "2026-02-26T12-00-00.000Z",
      startedAt: "2026-02-26T12:00:00.000Z",
    });
    const earlier = makeRecord({
      id: "2026-02-26T10-00-00.000Z",
      startedAt: "2026-02-26T10:00:00.000Z",
    });

    // Write later first to verify sorting
    writeRunRecord(tmpDir, later);
    writeRunRecord(tmpDir, earlier);

    const runs = listRuns(tmpDir);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe("2026-02-26T10-00-00.000Z");
    expect(runs[1].id).toBe("2026-02-26T12-00-00.000Z");
  });

  it("skips non-JSON files in the directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(runsDir);

    // Write a valid record
    writeRunRecord(tmpDir, makeRecord());

    // Write a non-JSON file
    fs.writeFileSync(path.join(runsDir, "notes.txt"), "some notes");

    const runs = listRuns(tmpDir);
    expect(runs).toHaveLength(1);
  });

  it("skips malformed JSON files without throwing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(runsDir);

    // Write a valid record
    writeRunRecord(tmpDir, makeRecord());

    // Write a malformed JSON file
    fs.writeFileSync(path.join(runsDir, "bad.json"), "not valid json{{{");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runs = listRuns(tmpDir);
    expect(runs).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
