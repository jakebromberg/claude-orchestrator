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

const MAX_DEPTH = 16;

interface Heredoc {
  delimiter: string;
  /** `<<-`: leading tabs are ignored on the delimiter line. */
  stripTabs: boolean;
  /** An unquoted delimiter: the body expands `$(...)` and backticks, so they run. */
  expands: boolean;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r";
/** Characters that end a heredoc delimiter word. */
const DELIMITER_END = /[\s;|&()<>]/;

/** The simple commands of `text`, in order of completion (a command inside a substitution is listed before the command that holds it), or `undefined` when it cannot be parsed. */
export function simpleCommands(text: string): string[][] | undefined {
  const out: string[][] = [];
  return parse(text, 0, false, 0, out) === undefined ? undefined : out;
}

/**
 * Parses `text` from `from`: to its end, or, with `closer`, to the `)` that closes a `$(` (returned index is just past it). Pushes each simple
 * command to `out`. Returns the end index, or `undefined` on text it cannot parse.
 */
function parse(text: string, from: number, closer: boolean, depth: number, out: string[][]): number | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let parens = 0;
  const heredocs: Heredoc[] = [];
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  /** A substitution inside a word contributes an empty piece: the word exists, its value is unknown. */
  const substituted = (): void => {
    inWord = true;
  };
  /** Parses `$(` at `i` (just past the opening) and returns the index past its `)`. */
  const commandSubstitution = (i: number): number | undefined => parse(text, i, true, depth + 1, out);
  /** Parses the backtick substitution whose opening backtick is at `i`; returns the index past the closing one. */
  const backticks = (i: number): number | undefined => {
    let j = i + 1;
    while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) return undefined;
    return parse(text.slice(i + 1, j).replace(/\\`/g, "`"), 0, false, depth + 1, out) === undefined ? undefined : j + 1;
  };
  /** Runs the substitutions of an unquoted heredoc body. */
  const expandBody = (body: string): boolean => {
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\") i++;
      else if (body[i] === "$" && body[i + 1] === "(") {
        const end = parse(body, i + 2, true, depth + 1, out);
        if (end === undefined) return false;
        i = end - 1;
      } else if (body[i] === "`") {
        let j = i + 1;
        while (j < body.length && body[j] !== "`") j += body[j] === "\\" ? 2 : 1;
        if (j >= body.length || parse(body.slice(i + 1, j), 0, false, depth + 1, out) === undefined) return false;
        i = j;
      }
    }
    return true;
  };
  /** Reads the pending heredocs' bodies starting at `i` (the first character after a newline); returns the index after the last delimiter line. */
  const readHeredocs = (start: number): number | undefined => {
    let i = start;
    for (const h of heredocs.splice(0)) {
      const body: string[] = [];
      for (;;) {
        if (i > text.length) return undefined;
        const nl = text.indexOf("\n", i);
        const line = text.slice(i, nl === -1 ? text.length : nl);
        const atEnd = nl === -1;
        i = atEnd ? text.length + 1 : nl + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter) break;
        body.push(line);
        if (atEnd) return undefined;
      }
      if (h.expands && !expandBody(body.join("\n"))) return undefined;
    }
    return Math.min(i, text.length);
  };
  /** Parses a heredoc delimiter word at `i` (after `<<` and an optional `-`); returns where it ends. */
  const delimiterWord = (i: number, stripTabs: boolean): number | undefined => {
    while (i < text.length && isSpace(text[i]!)) i++;
    let delimiter = "";
    let expands = true;
    let any = false;
    while (i < text.length && !DELIMITER_END.test(text[i]!)) {
      const c = text[i]!;
      any = true;
      if (c === "'" || c === '"') {
        const close = text.indexOf(c, i + 1);
        if (close === -1) return undefined;
        delimiter += text.slice(i + 1, close);
        expands = false;
        i = close + 1;
      } else if (c === "\\") {
        delimiter += text[i + 1] ?? "";
        expands = false;
        i += 2;
      } else {
        delimiter += c;
        i++;
      }
    }
    if (!any) return undefined;
    heredocs.push({ delimiter, stripTabs, expands });
    return i;
  };

  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      if (text[i + 1] === "\n") i += 2;
      else {
        word += text[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return undefined;
      word += text.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      for (;;) {
        if (i >= text.length) return undefined;
        const d = text[i]!;
        if (d === '"') break;
        if (d === "\\") {
          const e = text[i + 1] ?? "";
          word += '"\\$`'.includes(e) ? e : e === "\n" ? "" : `\\${e}`;
          i += 2;
        } else if (d === "$" && text[i + 1] === "(") {
          const end = commandSubstitution(i + 2);
          if (end === undefined) return undefined;
          i = end;
        } else if (d === "`") {
          const end = backticks(i);
          if (end === undefined) return undefined;
          i = end;
        } else {
          word += d;
          i++;
        }
      }
      i++;
    } else if (c === "$" && text[i + 1] === "'") {
      inWord = true;
      i += 2;
      for (;;) {
        if (i >= text.length) return undefined;
        if (text[i] === "'") break;
        if (text[i] === "\\") {
          word += text[i + 1] ?? "";
          i += 2;
        } else word += text[i++];
      }
      i++;
    } else if (c === "$" && text[i + 1] === "(") {
      const end = commandSubstitution(i + 2);
      if (end === undefined) return undefined;
      substituted();
      i = end;
    } else if (c === "`") {
      const end = backticks(i);
      if (end === undefined) return undefined;
      substituted();
      i = end;
    } else if (c === "#" && !inWord) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (isSpace(c)) {
      endWord();
      i++;
    } else if (c === "\n") {
      endCommand();
      i++;
      if (heredocs.length > 0) {
        const after = readHeredocs(i);
        if (after === undefined) return undefined;
        i = after;
      }
    } else if (c === "<" && text.startsWith("<<<", i)) {
      // A here-string is a redirect, not a heredoc.
      word += "<<<";
      inWord = true;
      i += 3;
    } else if (c === "<" && text[i + 1] === "<") {
      endWord();
      const stripTabs = text[i + 2] === "-";
      const end = delimiterWord(i + (stripTabs ? 3 : 2), stripTabs);
      if (end === undefined) return undefined;
      i = end;
    } else if (c === ";" || c === "|" || c === "(") {
      endCommand();
      if (c === "(") parens++;
      i++;
    } else if (c === ")") {
      endCommand();
      if (parens > 0) parens--;
      else if (closer) return heredocs.length === 0 ? i + 1 : undefined;
      i++;
    } else if (c === "&") {
      // The & of a redirect (`2>&1`, `>&2`, `&>`) belongs to its word; any other starts a new command.
      if (text[i + 1] === ">" || (inWord && /[<>]$/.test(word))) {
        word += c;
        inWord = true;
      } else endCommand();
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  if (closer || heredocs.length > 0) return undefined;
  endCommand();
  return text.length;
}
