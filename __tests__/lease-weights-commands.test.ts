import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoizedGit, weightForCommands, weightFor, type GitLookup } from "../src/lease-weights.js";

const GB = 2 ** 30;

describe("weightForCommands", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const plantTable = (rules: unknown[]): void => writeFileSync(join(dir, "weights.json"), JSON.stringify(rules));
  const counting = (toplevels: Record<string, string> = {}): GitLookup & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      toplevel: (d) => (calls.push(`toplevel:${d}`), toplevels[d] ?? ""),
      origin: (d) => (calls.push(`origin:${d}`), "git@github.com:acme/app.git"),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-weights-cmds-"));
    env = { CO_LEASE_DIR: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["no match", ["ls"], undefined],
    ["one match", ["npm test"], 2 * GB],
    ["the largest of several matches", ["npm test", "xcodebuild test", "ls"], 8 * GB],
    ["no commands", [], undefined],
  ])("%s", (_name, commands, expected) => {
    plantTable([{ pattern: "^npm test", gb: 2 }, { pattern: "^xcodebuild", gb: 8 }]);
    expect(weightForCommands(commands, "/work", env, () => {}, counting())).toBe(expected);
  });

  it("makes one toplevel and one origin call for several commands in one directory", () => {
    plantTable([{ pattern: "^a", repo: "/nowhere", gb: 1 }, { pattern: "^b", repo: "acme/other", gb: 1 }, { pattern: "^c", repo: "acme/app", gb: 3 }]);
    const git = counting();
    expect(weightForCommands(["a", "b", "c", "a", "b", "c"], "/work", env, () => {}, git)).toBe(3 * GB);
    expect(git.calls).toEqual(["toplevel:/work", "origin:/work"]);
  });

  it("memoizes per directory: each gets its own answer and one call", () => {
    const git = counting({ "/dir1": "/one", "/dir2": "/two" });
    const memo = memoizedGit(git);
    expect([memo.toplevel("/dir1"), memo.toplevel("/dir2"), memo.toplevel("/dir1"), memo.toplevel("/dir2")]).toEqual(["/one", "/two", "/one", "/two"]);
    expect(git.calls).toEqual(["toplevel:/dir1", "toplevel:/dir2"]);
  });

  it("caches a failed lookup as unknown", () => {
    let n = 0;
    const memo = memoizedGit({ toplevel: () => { n++; throw new Error("no git"); }, origin: () => "" });
    expect([memo.toplevel("/d"), memo.toplevel("/d")]).toEqual(["", ""]);
    expect(n).toBe(1);
  });

  it("weightFor is the single-command case", () => {
    plantTable([{ pattern: "^npm test", gb: 2 }]);
    expect(weightFor("npm test", "/work", env, () => {})).toBe(2 * GB);
  });
});
