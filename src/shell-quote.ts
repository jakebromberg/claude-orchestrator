/**
 * POSIX single-quote escape for shell interpolation.
 *
 * Wraps `s` in single quotes and rewrites any embedded single quotes via the
 * standard close-reopen trick (`'` → `'\''`). The result is safe to drop into
 * a shell command line as one argument; the shell will pass `s` to the
 * underlying program literally regardless of spaces, `$`, `*`, quotes, etc.
 *
 * Used at every site that constructs a command string for `execSync` so
 * paths, branch names, and other config-derived values can't break the
 * surrounding command (issue #28).
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
