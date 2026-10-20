import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseSuspension, readSuspensions, removeLeaseSuspension, removeSuspension, suspensionFile, suspensionOf, writeSuspension, type SuspensionRecord } from "../src/suspensions.js";
import { failFsCall } from "./helpers/lease.js";

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

  it.each<[string, () => void, SuspensionRecord | undefined]>([
    ["a valid record", () => put("4242.json", REC), REC],
    ["an owner's record", () => put("4242.json", { ...REC, by: "lease" }), { ...REC, by: "lease" }],
    ["a missing file", () => put("4243.json", REC), undefined],
    ["a missing directory", () => {}, undefined],
    ["malformed JSON", () => put("4242.json", "{nope"), undefined],
    ["a body that fails validation", () => put("4242.json", { ...REC, remindAt: 5 }), undefined],
    ["a body whose pgid is not the file's", () => put("4242.json", { ...REC, pgid: 4243 }), undefined],
    ["a directory in place of the file", () => mkdirSync(join(dir, "suspensions", "4242.json"), { recursive: true, mode: 0o700 }), undefined],
    ["a symlinked record", () => {
      put("real.json", REC);
      symlinkSync(join(dir, "suspensions", "real.json"), join(dir, "suspensions", "4242.json"));
    }, undefined],
    ["a symlinked suspensions/", () => {
      const real = join(dir, "real");
      mkdirSync(real);
      writeFileSync(join(real, "4242.json"), JSON.stringify(REC));
      symlinkSync(real, join(dir, "suspensions"));
    }, undefined],
  ])("suspensionOf: %s", (_n, setUp, want) => {
    setUp();
    expect(suspensionOf(dir, 4242)).toEqual(want);
  });

  it("suspensionOf throws on an I/O error, which readSuspensions reads as no record", () => {
    put("4242.json", REC);
    const restore = failFsCall("openSync", (p) => p.includes("suspensions"), "EIO");
    try {
      expect(() => suspensionOf(dir, 4242)).toThrow(expect.objectContaining({ code: "EIO" }));
      expect(() => leaseSuspension(dir, 4242)).toThrow(expect.objectContaining({ code: "EIO" }));
      expect(readSuspensions(dir)).toEqual([]);
    } finally {
      restore();
    }
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

  it("finds and removes only a record the lease wrote", () => {
    writeSuspension(dir, { ...REC, by: "lease" });
    writeSuspension(dir, { ...REC, pgid: 4243 });
    expect(leaseSuspension(dir, 4242)).toMatchObject({ pgid: 4242, by: "lease" });
    expect(leaseSuspension(dir, 4243)).toBeUndefined();
    expect(leaseSuspension(dir, 4244)).toBeUndefined();
    expect(removeLeaseSuspension(dir, 4243)).toBe(false);
    expect(removeLeaseSuspension(dir, 4244)).toBe(false);
    expect(removeLeaseSuspension(dir, 4242)).toBe(true);
    expect(readSuspensions(dir).map((r) => r.pgid)).toEqual([4243]);
  });
});
