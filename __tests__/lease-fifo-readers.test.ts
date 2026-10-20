import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIFO_READERS } from "./helpers/fifo-readers.js";

const here = dirname(fileURLToPath(import.meta.url));
const noFifos = process.platform === "win32";
// The TypeScript runner that vitest installs; the child needs one because the readers are imported from `src/`.
const runner = join(here, "../node_modules/.bin/vite-node");

describe.skipIf(noFifos)("a FIFO planted at a lease-directory record reads as absent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-fifo-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("has the child runner installed", () => {
    expect(existsSync(runner), `${runner} is missing; the FIFO rows below cannot run without it (it comes with vitest)`).toBe(true);
  });

  // No writer ever opens the FIFO, so a reader that opens it blocking waits forever; the child is killed at the timeout and the row fails by name.
  it.each(Object.entries(FIFO_READERS))("%s", (name, row) => {
    mkdirSync(dirname(join(dir, row.file)), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [join(dir, row.file)]);
    const child = spawnSync(runner, [join(here, "helpers/fifo-child.ts"), name, dir], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    const code = (child.error as NodeJS.ErrnoException | undefined)?.code;
    expect(code, `${name} blocked on the FIFO`).not.toBe("ETIMEDOUT");
    expect(child.error, `${name}: the child could not run`).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").pop()!)).toEqual(row.expected);
  });
});
