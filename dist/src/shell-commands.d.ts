/**
 * A small shell tokenizer for classifying what a command line runs (the UI-test class's matcher, `isUiTestCommand` in `lease-hook.ts`). It
 * splits text into simple commands, each as its words with quotes and escapes resolved, and knows what the hook's raw split does not: quotes
 * (`'...'`, `"..."`, `$'...'`), backslash escapes and line continuations, `#` comments, heredocs (a quoted body is skipped; an unquoted one
 * is only searched for `$(...)` and backticks, which run), `$(...)` (a `case` arm's `)` inside it does not close it), backticks, subshells, brace
 * groups, compound commands and function definitions. It is not a shell: no expansion, aliases, `eval` or arithmetic, and a word is never split after quoting.
 *
 * Text it cannot parse (an unterminated quote, substitution or heredoc, or nesting deeper than `MAX_DEPTH`) returns `undefined`, so a caller keeps
 * its own fallback instead of guessing; this module never throws and does linear work.
 */
/** One simple command: its words, and the body of the last heredoc fed to it, which is its stdin. */
export interface ShellCommand {
    words: string[];
    stdin?: string;
    /** An `&` separator follows it, or a pipeline, and-or list, group or subshell that holds it does (back to the last `;` or newline), so the shell returns before it ends. */
    background?: true;
}
/** The simple commands of `text`, in order of completion (a command inside a substitution is listed before the command that holds it), or `undefined` when it cannot be parsed. */
export declare function shellCommands(text: string): ShellCommand[] | undefined;
/**
 * `text` with its comments and its heredoc bodies that run nothing replaced by spaces (newlines kept), so a check that reads the raw text (a function
 * definition, a lone `&`) does not read prose as code. A heredoc body is a script when the command that reads it is a shell; the caller reads that
 * script as text of its own. Text that cannot be parsed comes back unchanged.
 */
export declare function blankInert(text: string): string;
/** `shellCommands`, as the words of each command only. */
export declare function simpleCommands(text: string): string[][] | undefined;
