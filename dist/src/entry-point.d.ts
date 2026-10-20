/** True when `moduleUrl` (a bin's `import.meta.url`) is the script node was started with. A bin runs through a symlink or shim (`node_modules/.bin/...`) and node leaves `process.argv[1]` unresolved, so this compares real paths; a missing or unresolvable `argv[1]` is false. No load-time side effects. */
export declare function isEntryPoint(moduleUrl: string): boolean;
