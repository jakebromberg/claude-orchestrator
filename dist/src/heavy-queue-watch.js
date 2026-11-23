/**
 * `heavy-queue watch`: a live, full-screen view of the machine-wide lease that redraws every interval until SIGINT or SIGTERM.
 * It reads the same view `status` prints (`statusView`) and never takes the lease's mutex or writes a ticket.
 */
const GB = 1024 ** 3;
const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_TO_END = "\x1b[J";
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
/** `m:ss` under an hour, `h:mm:ss` from an hour. */
function age(sec) {
    const s = Math.max(0, Math.floor(sec));
    const pad = (n) => String(n).padStart(2, "0");
    const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
function clock(now, timeZone) {
    return now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short", ...(timeZone && { timeZone }) });
}
/** Pads every column but the last to its widest cell, two spaces apart, each row indented two spaces. */
function table(rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 2))).join("")}`.trimEnd());
}
/** Draws one frame of the queue, or the read error in place of the tables. */
export function renderQueue(view, o) {
    const time = clock(o.now, o.timeZone);
    const lines = view instanceof Error ? [`heavy queue  ${time}`, "", `status unavailable: ${view.message}`] : frameLines(view, time);
    return lines.map((l) => l.slice(0, Math.max(1, o.width))).join("\n");
}
function frameLines(v, time) {
    const w = v.weights;
    const memory = w ? `  memory ${gb(w.used)} / ${gb(w.budget)} budget${w.free ? ` (free ${gb(w.free.freeBytes)}, reserve ${gb(w.free.reserve)})` : ""}` : "";
    const out = [`heavy queue  ${time}  level ${v.level}  capacity ${v.capacity}${memory}`, "", `RUNNING (${v.live.length})`];
    if (v.live.length === 0)
        out.push("  nothing running");
    else
        out.push(...table([["PID", "AGE", "PRI", "STATE", "COMMAND"], ...v.live.map((h) => [String(h.pid), age(h.ageSec), h.priority ?? "normal", h.suspended ? "SUSPENDED" : "running", h.command])]));
    const waiting = v.waiting ?? [];
    out.push("", `WAITING (${waiting.length})`);
    if (waiting.length === 0)
        out.push("  nothing waiting");
    else
        out.push(...table([["#", "SEQ", "PRI", "GATE", "LABEL"], ...waiting.map((t, i) => [String(i + 1), String(t.seq), t.priority ?? "normal", !t.gated ? "ungated" : t.ready ? "ready" : "blocked", t.label])]));
    if (v.unowned) {
        const u = v.unowned;
        const others = u.others.map((p) => `  ${p.command.split("/").at(-1)} (${p.pid}) ${gb(p.bytes)}`).join("");
        out.push("", `UNOWNED  claude ${gb(u.claude)}  simulators ${gb(u.simulators)}${others}`);
    }
    return out;
}
/** Redraws the queue every `intervalSec` until SIGINT or SIGTERM, then restores the screen and resolves 0. */
export function runWatch(args, d) {
    const draw = () => {
        let view;
        try {
            view = d.status();
        }
        catch (e) {
            view = e instanceof Error ? e : new Error(String(e));
        }
        const frame = renderQueue(view, { now: d.now(), width: d.columns(), ...(d.timeZone && { timeZone: d.timeZone }) });
        d.write(d.isTTY ? `${HOME}${frame.replaceAll("\n", `\x1b[K\n`)}\x1b[K${CLEAR_TO_END}` : `${frame}\n\n`);
    };
    return new Promise((resolve) => {
        if (d.isTTY)
            d.write(ENTER_SCREEN);
        draw();
        const cancel = d.every(draw, args.intervalSec * 1000);
        const stop = () => {
            cancel();
            d.signals.off("SIGINT", stop);
            d.signals.off("SIGTERM", stop);
            if (d.isTTY)
                d.write(LEAVE_SCREEN);
            resolve(0);
        };
        d.signals.once("SIGINT", stop);
        d.signals.once("SIGTERM", stop);
    });
}
//# sourceMappingURL=heavy-queue-watch.js.map