import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic-write.js";
import { readSuspensions, suspensionFile, writeSuspension, type SuspensionRecord } from "../src/suspensions.js";
import { failFsCall } from "./helpers/lease.js";

// No `vi.mock("node:fs")` here (unlike `atomic-write.test.ts`, whose hoisted mock owns `renameSync`): faults go through `failFsCall`.
const isTemp = (p: string) => p.endsWith(".tmp");
const REC: SuspensionRecord = { pgid: 4242, by: "jake", reason: "demo", at: "2026-10-16T12:00:00.000Z", remindAt: "2026-10-16T14:00:00.000Z", leader: null };

describe("writeFileAtomic's best-effort temp removal", () => {
  let dir: string;
  let file: string;
  let restores: Array<() => void>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-cleanup-"));
    file = join(dir, "record.json");
    restores = [];
  });
  afterEach(() => {
    restores.forEach((r) => r());
    rmSync(dir, { recursive: true, force: true });
  });

  it.each<{ name: string; exclusive: boolean; existing: boolean; fail?: "renameSync" | "linkSync"; code?: string; expected: string | undefined; content: string | null }>([
    { name: "exclusive write: rmSync throws after the link", exclusive: true, existing: false, expected: undefined, content: "new" },
    { name: "exclusive write onto an existing target: EEXIST wins over the rmSync error", exclusive: true, existing: true, expected: "EEXIST", content: "old" },
    { name: "exclusive write: a link error wins over the rmSync error", exclusive: true, existing: false, fail: "linkSync", code: "ENOSPC", expected: "ENOSPC", content: null },
    { name: "rename write: the rename error wins over the rmSync error", exclusive: false, existing: false, fail: "renameSync", code: "ENOSPC", expected: "ENOSPC", content: null },
  ])("$name", ({ exclusive, existing, fail, code, expected, content }) => {
    if (existing) writeFileSync(file, "old");
    if (fail) restores.push(failFsCall(fail, (p) => isTemp(p), code!));
    restores.push(failFsCall("rmSync", isTemp, "EIO"));
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeFileAtomic(file, "new", { exclusive });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }
    expect(thrown?.code).toBe(expected);
    expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(content);
  });

  it("writeSuspension returns and leaves the record on disk when rmSync throws after the link", () => {
    mkdirSync(join(dir, "suspensions"), { mode: 0o700 });
    restores.push(failFsCall("rmSync", isTemp, "EIO"));
    expect(() => writeSuspension(dir, REC)).not.toThrow();
    expect(readSuspensions(dir)).toEqual([REC]);
    expect(readdirSync(join(dir, "suspensions")).filter((n) => !n.endsWith(".tmp"))).toEqual([`${REC.pgid}.json`]);
    expect(existsSync(suspensionFile(dir, REC.pgid))).toBe(true);
  });
});
