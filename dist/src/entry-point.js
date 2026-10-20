import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** True when `moduleUrl` (a bin's `import.meta.url`) is the script node was started with. A bin runs through a symlink or shim (`node_modules/.bin/...`) and node leaves `process.argv[1]` unresolved, so this compares real paths; a missing or unresolvable `argv[1]` is false. No load-time side effects. */
export function isEntryPoint(moduleUrl) {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=entry-point.js.map