import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntryPoint } from "../src/entry-point.js";

describe("isEntryPoint", () => {
  let tmp: string;
  let argv1: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "entry-point-"));
    argv1 = process.argv[1];
  });
  afterEach(() => {
    process.argv[1] = argv1 as string;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("compares real paths", () => {
    const real = join(tmp, "real.js");
    const other = join(tmp, "other.js");
    writeFileSync(real, "");
    writeFileSync(other, "");
    symlinkSync(real, join(tmp, "link.js"));
    const url = pathToFileURL(real).href;
    const rows: [string, string | undefined, boolean][] = [
      ["direct path", real, true],
      ["symlink", join(tmp, "link.js"), true],
      ["other file", other, false],
      ["missing argv[1]", undefined, false],
      ["argv[1] that does not exist", join(tmp, "nope.js"), false],
      ["extensionless argv[1]", join(tmp, "real"), true],
      ["extensionless argv[1] of another file", join(tmp, "other"), false],
      ["extensionless argv[1] with no file", join(tmp, "nope"), false],
    ];
    for (const [name, arg, want] of rows) {
      process.argv[1] = arg as string;
      expect(isEntryPoint(url), name).toBe(want);
    }
  });
});

describe("import.meta.main", () => {
  it.each([
    [true, "/nowhere", true],
    [false, undefined, false],
  ])("main %s decides before argv[1] is read", (main, arg, want) => {
    const saved = process.argv[1];
    process.argv[1] = arg as string;
    try {
      expect(isEntryPoint(pathToFileURL("/x/real.js").href, main)).toBe(want);
    } finally {
      process.argv[1] = saved as string;
    }
  });
});

describe("built bins run through a symlink", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bin-link-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.each(["cli-claim", "cli-heavy-queue", "cli-lease", "cli-merge-appendable", "cli-watchdog"])("%s does its work", (bin) => {
    const link = join(tmp, `${bin}.js`);
    symlinkSync(join(__dirname, "..", "dist", "src", `${bin}.js`), link);
    const r = spawnSync(process.execPath, [link, "--bogus-flag"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toBe("");
  });
});

describe("built bins run by an extensionless path", () => {
  it.each(["cli-claim", "cli-heavy-queue", "cli-lease", "cli-merge-appendable", "cli-watchdog"])("%s does its work", (bin) => {
    const r = spawnSync(process.execPath, [join(__dirname, "..", "dist", "src", bin), "--bogus-flag"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toBe("");
  });
});
