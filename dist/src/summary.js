import { colors } from "./log.js";
/**
 * Creates a `printSummary` function matching the `OrchestratorHooks` signature.
 * Each config provides column definitions and a title; the renderer handles
 * layout, colorization, and totals.
 */
export function createPrintSummary(options) {
    const { title, columns, extraTotals } = options;
    return (issues, getStatus) => {
        const { BOLD, NC, GREEN, RED, YELLOW, DIM } = colors;
        // Title
        console.log(`${BOLD}${title}${NC}`);
        console.log("");
        // Column headers
        const headerLine = columns.map((c) => c.header.padEnd(c.width)).join(" ");
        console.log(`  ${BOLD}${headerLine}${NC}`);
        // Separator
        const separatorLine = columns.map((c) => "-".repeat(c.width)).join(" ");
        console.log(`  ${separatorLine}`);
        // Rows
        for (const issue of issues) {
            const status = getStatus(issue.number);
            let color = NC;
            if (status === "succeeded")
                color = GREEN;
            else if (status === "failed")
                color = RED;
            else if (status === "running" || status === "interrupted")
                color = YELLOW;
            else if (status === "skipped")
                color = DIM;
            const cells = columns.map((c) => c.value(issue, status).padEnd(c.width).slice(0, c.width));
            console.log(`  ${color}${cells.join(" ")}${NC}`);
        }
        console.log("");
        // Totals
        let succeeded = 0, failed = 0, running = 0, pending = 0, skipped = 0;
        for (const issue of issues) {
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
        let totalsLine = `  ${GREEN}Succeeded: ${succeeded}${NC}  ${RED}Failed: ${failed}${NC}  ${YELLOW}Running: ${running}${NC}  Pending: ${pending}  ${DIM}Skipped: ${skipped}${NC}  Total: ${issues.length}`;
        if (extraTotals) {
            totalsLine += ` ${extraTotals(issues)}`;
        }
        console.log(totalsLine);
        console.log("");
    };
}
//# sourceMappingURL=summary.js.map