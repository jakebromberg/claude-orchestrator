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
const isSpace = (c) => c === " " || c === "\t" || c === "\r";
/** Characters that end a heredoc delimiter word. */
const DELIMITER_END = /[\s;|&()<>]/;
/** The simple commands of `text`, in order of completion (a command inside a substitution is listed before the command that holds it), or `undefined` when it cannot be parsed. */
export function shellCommands(text) {
    const out = [];
    return parse(text, 0, false, 0, out) === undefined ? undefined : out;
}
/** `shellCommands`, as the words of each command only. */
export function simpleCommands(text) {
    return shellCommands(text)?.map((c) => c.words);
}
/**
 * Parses `text` from `from`: to its end, or, with `closer`, to the `)` that closes a `$(` (returned index is just past it). Pushes each simple
 * command to `out`. Returns the end index, or `undefined` on text it cannot parse.
 */
function parse(text, from, closer, depth, out) {
    if (depth > MAX_DEPTH)
        return undefined;
    let words = [];
    let word = "";
    let inWord = false;
    /** The current word held a quote or an escape, so it is not a bare file descriptor number. */
    let quoted = false;
    /** A redirect operator was read: the next word is its target, not a word of the command. */
    let pendingTarget = false;
    /** Where the current statement (since the last `;`, newline or `&`) starts in `out`, and where each open `(` group did. */
    let segStart = out.length;
    const groups = [];
    /** Where each `{` group (a command whose first word is `{`) started in `out`. */
    const braces = [];
    let parens = 0;
    const heredocs = [];
    /** The heredocs opened by the command being read; its end gives them an owner, which a later body read fills. */
    let opened = [];
    const endWord = () => {
        if (inWord && pendingTarget)
            pendingTarget = false;
        else if (inWord)
            words.push(word);
        word = "";
        inWord = false;
        quoted = false;
    };
    /** Ends the statement: what follows starts a new one. */
    const endStatement = () => {
        endCommand();
        segStart = out.length;
    };
    const endCommand = () => {
        endWord();
        if (words.length > 0) {
            const command = { words };
            out.push(command);
            for (const h of opened)
                h.owner = command;
            if (words[0] === "{")
                braces.push(out.length - 1);
            else if (words[0] === "}" && braces.length > 0)
                segStart = braces.pop(); // what follows `}` (an `&`) reaches the whole group
        }
        opened = [];
        words = [];
        pendingTarget = false;
    };
    /** A substitution inside a word contributes an empty piece: the word exists, its value is unknown. */
    const substituted = () => {
        inWord = true;
    };
    /** Parses `$(` at `i` (just past the opening) and returns the index past its `)`. */
    const commandSubstitution = (i) => parse(text, i, true, depth + 1, out);
    /** Parses the backtick substitution whose opening backtick is at `i`; returns the index past the closing one. */
    const backticks = (i) => {
        let j = i + 1;
        while (j < text.length && text[j] !== "`")
            j += text[j] === "\\" ? 2 : 1;
        if (j >= text.length)
            return undefined;
        return parse(text.slice(i + 1, j).replace(/\\`/g, "`"), 0, false, depth + 1, out) === undefined ? undefined : j + 1;
    };
    /** Runs the substitutions of an unquoted heredoc body. */
    const expandBody = (body) => {
        for (let i = 0; i < body.length; i++) {
            if (body[i] === "\\")
                i++;
            else if (body[i] === "$" && body[i + 1] === "(") {
                const end = parse(body, i + 2, true, depth + 1, out);
                if (end === undefined)
                    return false;
                i = end - 1;
            }
            else if (body[i] === "`") {
                let j = i + 1;
                while (j < body.length && body[j] !== "`")
                    j += body[j] === "\\" ? 2 : 1;
                if (j >= body.length || parse(body.slice(i + 1, j), 0, false, depth + 1, out) === undefined)
                    return false;
                i = j;
            }
        }
        return true;
    };
    /** Reads the pending heredocs' bodies starting at `i` (the first character after a newline); returns the index after the last delimiter line. */
    const readHeredocs = (start) => {
        let i = start;
        for (const h of heredocs.splice(0)) {
            const body = [];
            for (;;) {
                if (i > text.length)
                    return undefined;
                const nl = text.indexOf("\n", i);
                const line = text.slice(i, nl === -1 ? text.length : nl);
                const atEnd = nl === -1;
                i = atEnd ? text.length + 1 : nl + 1;
                if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter)
                    break;
                body.push(line);
                if (atEnd)
                    return undefined;
            }
            const bodyText = (h.stripTabs ? body.map((l) => l.replace(/^\t+/, "")) : body).join("\n");
            if (h.owner)
                h.owner.stdin = bodyText;
            if (h.expands && !expandBody(body.join("\n")))
                return undefined;
        }
        return Math.min(i, text.length);
    };
    /** Parses a heredoc delimiter word at `i` (after `<<` and an optional `-`); returns where it ends. */
    const delimiterWord = (i, stripTabs) => {
        while (i < text.length && isSpace(text[i]))
            i++;
        let delimiter = "";
        let expands = true;
        let any = false;
        while (i < text.length && !DELIMITER_END.test(text[i])) {
            const c = text[i];
            any = true;
            if (c === "'" || c === '"') {
                const close = text.indexOf(c, i + 1);
                if (close === -1)
                    return undefined;
                delimiter += text.slice(i + 1, close);
                expands = false;
                i = close + 1;
            }
            else if (c === "\\") {
                delimiter += text[i + 1] ?? "";
                expands = false;
                i += 2;
            }
            else {
                delimiter += c;
                i++;
            }
        }
        if (!any)
            return undefined;
        const heredoc = { delimiter, stripTabs, expands };
        heredocs.push(heredoc);
        opened.push(heredoc);
        return i;
    };
    let i = from;
    while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
            if (text[i + 1] === "\n")
                i += 2;
            else {
                word += text[i + 1] ?? "";
                inWord = true;
                quoted = true;
                i += 2;
            }
        }
        else if (c === "'") {
            const close = text.indexOf("'", i + 1);
            if (close === -1)
                return undefined;
            word += text.slice(i + 1, close);
            inWord = true;
            quoted = true;
            i = close + 1;
        }
        else if (c === '"') {
            inWord = true;
            quoted = true;
            i++;
            for (;;) {
                if (i >= text.length)
                    return undefined;
                const d = text[i];
                if (d === '"')
                    break;
                if (d === "\\") {
                    const e = text[i + 1] ?? "";
                    word += '"\\$`'.includes(e) ? e : e === "\n" ? "" : `\\${e}`;
                    i += 2;
                }
                else if (d === "$" && text[i + 1] === "(") {
                    const end = commandSubstitution(i + 2);
                    if (end === undefined)
                        return undefined;
                    i = end;
                }
                else if (d === "`") {
                    const end = backticks(i);
                    if (end === undefined)
                        return undefined;
                    i = end;
                }
                else {
                    word += d;
                    i++;
                }
            }
            i++;
        }
        else if (c === "$" && text[i + 1] === "'") {
            inWord = true;
            quoted = true;
            i += 2;
            for (;;) {
                if (i >= text.length)
                    return undefined;
                if (text[i] === "'")
                    break;
                if (text[i] === "\\") {
                    word += text[i + 1] ?? "";
                    i += 2;
                }
                else
                    word += text[i++];
            }
            i++;
        }
        else if (c === "$" && text[i + 1] === "(") {
            const end = commandSubstitution(i + 2);
            if (end === undefined)
                return undefined;
            substituted();
            i = end;
        }
        else if (c === "`") {
            const end = backticks(i);
            if (end === undefined)
                return undefined;
            substituted();
            i = end;
        }
        else if (c === "#" && !inWord) {
            while (i < text.length && text[i] !== "\n")
                i++;
        }
        else if (isSpace(c)) {
            endWord();
            i++;
        }
        else if (c === "\n") {
            endStatement();
            i++;
            if (heredocs.length > 0) {
                const after = readHeredocs(i);
                if (after === undefined)
                    return undefined;
                i = after;
            }
        }
        else if (c === "<" && text.startsWith("<<<", i)) {
            // A here-string is a redirect, not a heredoc.
            word += "<<<";
            inWord = true;
            i += 3;
        }
        else if (c === "<" && text[i + 1] === "<") {
            endWord();
            const stripTabs = text[i + 2] === "-";
            const end = delimiterWord(i + (stripTabs ? 3 : 2), stripTabs);
            if (end === undefined)
                return undefined;
            i = end;
        }
        else if ((c === "<" || c === ">") && text[i + 1] !== "(") {
            // A redirect operator ends the word before it (a bare number there is its file descriptor, kept with it) and the word after it is its target.
            if (inWord && !quoted && /^\d+$/.test(word)) {
                word = "";
                inWord = false;
            }
            else
                endWord();
            i++;
            if (c === ">" && (text[i] === ">" || text[i] === "|"))
                i++;
            else if (c === "<" && text[i] === ">")
                i++;
            else if (text[i] === "&")
                i++; // `>&` and `<&` duplicate or close a descriptor
            pendingTarget = true;
        }
        else if (c === ";") {
            endStatement();
            i++;
        }
        else if (c === "|") {
            endCommand();
            i += text[i + 1] === "&" ? 2 : 1; // `|&` is a pipe
        }
        else if (c === "(") {
            endCommand();
            groups.push(out.length);
            parens++;
            i++;
        }
        else if (c === ")") {
            endCommand();
            if (parens > 0) {
                parens--;
                segStart = groups.pop() ?? segStart; // what follows `)` (an `&`) reaches the whole group
            }
            else if (closer)
                return heredocs.length === 0 ? i + 1 : undefined;
            i++;
        }
        else if (c === "&") {
            if (text[i + 1] === ">") {
                // `&>` and `&>>` redirect both streams.
                endWord();
                i += text[i + 2] === ">" ? 3 : 2;
                pendingTarget = true;
            }
            else if (text[i + 1] === "&") {
                endCommand(); // `&&` continues the and-or list: no new statement
                i += 2;
            }
            else {
                // A lone `&` backgrounds the statement so far: every command since its start.
                endCommand();
                for (let k = segStart; k < out.length; k++)
                    out[k].background = true;
                segStart = out.length;
                i++;
            }
        }
        else {
            word += c;
            inWord = true;
            i++;
        }
    }
    if (closer || heredocs.length > 0)
        return undefined;
    endCommand();
    return text.length;
}
//# sourceMappingURL=shell-commands.js.map