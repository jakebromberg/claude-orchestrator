/**
 * A small shell tokenizer for classifying what a command line runs (the UI-test class's matcher, `isUiTestCommand` in `lease-hook.ts`). It
 * splits text into simple commands, each as its words with quotes and escapes resolved, and knows what the hook's raw split does not: quotes
 * (`'...'`, `"..."`, `$'...'`), backslash escapes and line continuations, `#` comments, heredocs (a quoted body is skipped; an unquoted one
 * is only searched for `$(...)` and backticks, which run), `$(...)`, backticks, subshells and brace groups. It is not a shell: no
 * expansion, aliases, functions, `eval`, arithmetic or `case`, and a word is never split after quoting.
 *
 * Text it cannot parse (an unterminated quote, substitution or heredoc, or nesting deeper than `MAX_DEPTH`) returns `undefined`, so a caller keeps
 * its own fallback instead of guessing; this module never throws and does linear work.
 */
/** The simple commands of `text`, in order of completion (a command inside a substitution is listed before the command that holds it), or `undefined` when it cannot be parsed. */
export declare function simpleCommands(text: string): string[][] | undefined;
