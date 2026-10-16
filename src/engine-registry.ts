import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { ensureOwnSubdir } from "./lease-dir.js";
import { psField } from "./ps.js";
import type { EngineInfo, EngineRegistry } from "./types.js";

export interface FileEngineRegistryOptions {
  /** The lease directory; records live in `<dir>/engines/<pid>.json`. */
  dir: string;
  pid?: number;
  /** Reads the process group id; a throw or a non-integer result records `null`. */
  pgid?: (pid: number) => number;
  now?: () => Date;
}

const REFRESH_MS = 30_000;

/** The bounded `ps` reader (see `ps.ts`): a hung `ps` must not slow engine start. */
const psPgid = (pid: number): number => Number(psField(pid, "pgid"));

/**
 * File-backed registry: writes `engines/<pid>.json` at `start`, rewrites it every 30 s on an unref'd timer
 * (its mtime tells a reader a live engine from a dead one) and removes it at `stop`. `engines/` follows the lease's directory rule (`ensureOwnSubdir`); I/O errors, a refused directory included, are swallowed.
 */
export function createFileEngineRegistry(options: FileEngineRegistryOptions): EngineRegistry {
  const pid = options.pid ?? process.pid;
  const file = join(options.dir, "engines", `${pid}.json`);
  let timer: NodeJS.Timeout | undefined;

  const write = (record: object): void => {
    try {
      ensureOwnSubdir(options.dir, "engines");
      writeFileAtomic(file, JSON.stringify(record));
    } catch {}
  };

  return {
    start(info: EngineInfo) {
      let pgid: number | null = null;
      try {
        const read = (options.pgid ?? psPgid)(pid);
        if (Number.isInteger(read)) pgid = read;
      } catch {}
      const record = { pid, pgid, ...info, startedAt: (options.now?.() ?? new Date()).toISOString() };
      write(record);
      timer = setInterval(() => write(record), REFRESH_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      try { rmSync(file, { force: true }); } catch {}
    },
  };
}
