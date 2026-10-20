import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSuspensions, removeSuspension, suspensionFile, writeSuspension, type SuspensionRecord } from "../src/suspensions.js";

const REC: SuspensionRecord = { pgid: 4242, by: "jake", reason: "demo", at: "2026-10-16T12:00:00.000Z", remindAt: "2026-10-16T14:00:00.000Z", leader: "sleep 100" };

describe("suspension records", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suspension-records-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: unknown) => {
    mkdirSync(join(dir, "suspensions"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "suspensions", name), typeof body === "string" ? body : JSON.stringify(body));
  };

  it.each<[string, () => void, SuspensionRecord[]]>([
    ["a valid record", () => put("4242.json", REC), [REC]],
    ["a null leader", () => put("4242.json", { ...REC, leader: null }), [{ ...REC, leader: null }]],
    ["a non-pid stem", () => put("abc.json", { ...REC, pgid: 1 }), []],
    ["a stem the body disagrees with", () => put("4243.json", REC), []],
    ["malformed JSON", () => put("4242.json", "{nope"), []],
    ["a body that fails validation", () => put("4242.json", { ...REC, remindAt: 5 }), []],
    ["a remindAt that is not a date", () => put("4242.json", { ...REC, remindAt: "soon" }), []],
    ["a leading-zero stem beside the canonical record", () => { put("4242.json", REC); put("04242.json", "{nope"); }, [REC]],
    ["a leading-zero stem alone", () => put("04242.json", REC), []],
    ["a writeFileAtomic temp name", () => put("4242.json.1.ab.tmp", REC), []],
    ["a missing directory", () => {}, []],
    ["a symlinked suspensions/", () => {
      const real = join(dir, "real");
      mkdirSync(real);
      writeFileSync(join(real, "4242.json"), JSON.stringify(REC));
      symlinkSync(real, join(dir, "suspensions"));
    }, []],
  ])("readSuspensions: %s", (_n, setUp, want) => {
    setUp();
    const before = readdirSync(dir);
    expect(readSuspensions(dir)).toEqual(want);
    expect(readdirSync(dir)).toEqual(before);
  });

  it("round-trips a record and reports removal once", () => {
    writeSuspension(dir, REC);
    expect(readSuspensions(dir)).toEqual([REC]);
    expect(() => writeSuspension(dir, REC)).toThrow(/already has a suspension record/);
    expect(() => writeSuspension(dir, REC)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(removeSuspension(dir, REC.pgid)).toBe(true);
    expect(removeSuspension(dir, REC.pgid)).toBe(false);
    expect(readSuspensions(dir)).toEqual([]);
    expect(suspensionFile(dir, 7)).toBe(join(dir, "suspensions", "7.json"));
  });

  it("removes the temp files of dead writers from suspensions/ before it writes, and keeps a live writer's", () => {
    put("4242.json.2147483000.ab12cd34.tmp", "{");
    put(`4242.json.${process.pid}.ab12cd34.tmp`, "{");
    writeSuspension(dir, REC);
    expect(readdirSync(join(dir, "suspensions")).sort()).toEqual(["4242.json", `4242.json.${process.pid}.ab12cd34.tmp`]);
  });
});
