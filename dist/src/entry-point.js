import { realpathSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
/** True when `moduleUrl` (a bin's `import.meta.url`) is the script node was started with. `main` (the bin's `import.meta.main`) decides alone when node defines it, whatever spelling of the path was used. Otherwise a bin run through a symlink or shim (`node_modules/.bin/...`) leaves `process.argv[1]` unresolved, so this compares real paths, retrying an extensionless `argv[1]` with the module's extension; a missing or unresolvable `argv[1]` is false. No load-time side effects. */
export function isEntryPoint(moduleUrl, main) {
    if (main !== undefined)
        return main;
    const entry = process.argv[1];
    if (!entry)
        return false;
    const file = fileURLToPath(moduleUrl);
    try {
        return realpathSync(entry) === realpathSync(file);
    }
    catch {
        try {
            return !extname(entry) && realpathSync(entry + extname(file)) === realpathSync(file);
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=entry-point.js.map