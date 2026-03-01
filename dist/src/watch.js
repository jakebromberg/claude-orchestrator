import path from "node:path";
import fs from "node:fs";
import { colors } from "./log.js";
const COLUMNS = [
    { header: "Issue", width: 7, value: (i) => `#${i.number}` },
    { header: "Repo", width: 12, value: (i) => i.repo ?? "-" },
    { header: "Description", width: 25, value: (i) => i.description },
    { header: "Wave", width: 6, value: (i) => String(i.wave) },
    { header: "Status", width: 14, value: (_, s) => s },
    { header: "Last Output", width: 40, value: (_i, _s, line) => line },
];
// ---------------------------------------------------------------------------
// renderDashboard — pure function, no I/O
// ---------------------------------------------------------------------------
export function renderDashboard(options) {
    const { config, getStatus, getLastLogLine } = options;
    const { BOLD, NC, GREEN, RED, YELLOW, DIM } = colors;
    const lines = [];
    // Clear screen
    lines.push("\x1b[2J\x1b[H");
    // Title
    lines.push(`${BOLD}${config.name} (watching \u2014 refresh 2s)${NC}`);
    lines.push("");
    // Column headers
    const headerLine = COLUMNS.map((c) => c.header.padEnd(c.width)).join(" ");
    lines.push(`  ${BOLD}${headerLine}${NC}`);
    // Separator
    const separator = COLUMNS.map((c) => "-".repeat(c.width)).join(" ");
    lines.push(`  ${separator}`);
    // Rows
    for (const issue of config.issues) {
        const status = getStatus(issue.number);
        const logLine = getLastLogLine(issue);
        let color = NC;
        if (status === "succeeded")
            color = GREEN;
        else if (status === "failed")
            color = RED;
        else if (status === "running" || status === "interrupted")
            color = YELLOW;
        else if (status === "skipped")
            color = DIM;
        const cells = COLUMNS.map((c) => c.value(issue, status, logLine).padEnd(c.width).slice(0, c.width));
        lines.push(`  ${color}${cells.join(" ")}${NC}`);
    }
    lines.push("");
    // Totals
    let succeeded = 0, failed = 0, running = 0, pending = 0, skipped = 0;
    for (const issue of config.issues) {
        const status = getStatus(issue.number);
        if (status === "succeeded")
            succeeded++;
        else if (status === "failed")
            failed++;
        else if (status === "running")
            running++;
        else if (status === "skipped")
            skipped++;
        else
            pending++;
    }
    lines.push(`  ${GREEN}Succeeded: ${succeeded}${NC}  ${RED}Failed: ${failed}${NC}  ${YELLOW}Running: ${running}${NC}  Pending: ${pending}  ${DIM}Skipped: ${skipped}${NC}  Total: ${config.issues.length}`);
    lines.push("");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// readLastLogLine — reads last 4KB of a file to extract last non-empty line
// ---------------------------------------------------------------------------
function defaultReadFileTail(filePath, bytes) {
    const fd = fs.openSync(filePath, "r");
    try {
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - bytes);
        const buf = Buffer.alloc(Math.min(bytes, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString("utf-8");
    }
    finally {
        fs.closeSync(fd);
    }
}
export function readLastLogLine(logPath, readFileTail = defaultReadFileTail) {
    try {
        const tail = readFileTail(logPath, 4096);
        const lines = tail.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (trimmed.length > 0)
                return trimmed;
        }
        return "";
    }
    catch {
        return "";
    }
}
// ---------------------------------------------------------------------------
// startWatch — polling loop with injectable dependencies
// ---------------------------------------------------------------------------
export function startWatch(options) {
    const { config, statusStore, write, readFileTail = defaultReadFileTail, interval = 2000, } = options;
    function tick() {
        const output = renderDashboard({
            config,
            getStatus: (n) => statusStore.get(n),
            getLastLogLine: (issue) => {
                const logPath = path.join(config.configDir, "logs", `issue-${issue.number}.log`);
                return readLastLogLine(logPath, readFileTail);
            },
        });
        write(output);
    }
    // Render immediately
    tick();
    const timer = setInterval(tick, interval);
    return {
        stop() {
            clearInterval(timer);
        },
    };
}
//# sourceMappingURL=watch.js.map