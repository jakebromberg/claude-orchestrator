/** True for an `execSync`/`spawnSync` failure caused by its `timeout` option (ETIMEDOUT, or the kill signal it sends). */
export function isTimeoutError(error) {
    const e = error;
    return e?.code === "ETIMEDOUT" || e?.signal === "SIGTERM";
}
/** One line for the failure of a call bounded at `boundMs`: `timed out at the <n> s bound`, else the error's non-empty lines joined with `; `. */
export function describeBoundedFailure(error, boundMs) {
    if (isTimeoutError(error))
        return `timed out at the ${boundMs / 1000} s bound`;
    const text = error instanceof Error ? error.message : String(error);
    return text.split("\n").map((l) => l.trim()).filter(Boolean).join("; ");
}
//# sourceMappingURL=bounded-failure.js.map