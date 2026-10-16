import type { EngineRegistry } from "./types.js";
export interface FileEngineRegistryOptions {
    /** The lease directory; records live in `<dir>/engines/<pid>.json`. */
    dir: string;
    pid?: number;
    /** Reads the process group id; a throw or a non-integer result records `null`. */
    pgid?: (pid: number) => number;
    now?: () => Date;
}
/**
 * File-backed registry: writes `engines/<pid>.json` at `start`, rewrites it every 30 s on an unref'd timer
 * (its mtime tells a reader a live engine from a dead one) and removes it at `stop`. `engines/` follows the lease's directory rule (`ensureOwnSubdir`); I/O errors, a refused directory included, are swallowed.
 */
export declare function createFileEngineRegistry(options: FileEngineRegistryOptions): EngineRegistry;
