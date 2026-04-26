export function parseArgs(argv) {
    const result = {
        mode: "run-all",
        wave: undefined,
        issues: [],
        maxParallel: 4,
        mergeAfterWave: false,
        detach: false,
        notify: false,
    };
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case "--help":
            case "-h":
                result.mode = "help";
                i++;
                break;
            case "--status":
                result.mode = "status";
                i++;
                break;
            case "--cleanup":
                result.mode = "cleanup";
                i++;
                break;
            case "--watch":
                result.mode = "watch";
                i++;
                break;
            case "--merge":
                result.mode = "merge";
                i++;
                break;
            case "--merge-after-wave":
                result.mergeAfterWave = true;
                i++;
                break;
            case "--detach":
                result.detach = true;
                i++;
                break;
            case "--notify":
                result.notify = true;
                i++;
                break;
            case "--tail":
                result.mode = "tail";
                i++;
                break;
            case "--retry-failed":
                result.mode = "retry-failed";
                i++;
                break;
            case "--decompose":
                result.mode = "decompose";
                i++;
                break;
            case "--dashboard":
                result.mode = "dashboard";
                i++;
                break;
            case "--port": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--port requires a number");
                }
                result.port = parseInt(next, 10);
                i += 2;
                break;
            }
            case "--file": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--file requires a path");
                }
                result.decomposeFile = next;
                i += 2;
                break;
            }
            case "--create-issues":
                result.createIssues = true;
                i++;
                break;
            case "--issue": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--issue requires a number");
                }
                result.decomposeIssue = parseInt(next, 10);
                i += 2;
                break;
            }
            case "--repo": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--repo requires owner/repo");
                }
                result.decomposeRepo = next;
                i += 2;
                break;
            }
            case "--wave": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--wave requires an argument");
                }
                result.wave = parseInt(next, 10);
                i += 2;
                break;
            }
            case "--parallel": {
                const next = argv[i + 1];
                if (next === undefined || next.startsWith("-")) {
                    throw new Error("--parallel requires a number");
                }
                result.maxParallel = parseInt(next, 10);
                i += 2;
                break;
            }
            default:
                if (arg.startsWith("-")) {
                    throw new Error(`Unknown option: ${arg}`);
                }
                result.issues.push(parseInt(arg, 10));
                i++;
                break;
        }
    }
    if (result.issues.length > 0) {
        result.mode = "run-specific";
    }
    return result;
}
//# sourceMappingURL=cli.js.map