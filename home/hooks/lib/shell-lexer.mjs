// Character-level shell lexer: the second, independent parser behind pre-bash-guard's "matched in raw text" backstop, and the
// source of truth for heredocs and `$(...)` bodies inside double quotes. Pure, no I/O, never evaluates anything.
// Exports: lexShell(text) -> {rawSegs, nested, stripped}; isSimpleSubstitutionBody; markPiped, opensArrayList, markArrayList (also used
// by the regex tokenizer).
//   rawSegs   simple commands as lists of RAW words (quotes and escapes intact; `.piped` is true when a `|` fed the segment, `.arrayList`
//             when the segment is the element list of `NAME=(...)` / `NAME+=(...)`)
//   nested    bodies of `$(...)` / backticks found inside double quotes at the top level (the caller lexes them again)
//   stripped  the text without heredoc bodies and their terminator lines
// It follows the real nesting: quotes, `$'..'`, comments, `$((..))` arithmetic, `$(...)` inside double quotes (where quotes nest
// again) and heredocs wherever they start. So `<<EOF` inside quotes, a comment or `$((1<<X))` is not a heredoc, and a heredoc
// inside `"$(cat <<'EOF' ... EOF)"` is. A heredoc without a terminator line is left in place (its body is still checked).
// Outside double quotes `$(`, `(`, `)` and backticks only separate commands (flat), like the regex tokenizer in shell-words.mjs;
// but the words after the `)` that closes a `$(` go back to the segment that held the `$` (`echo $(a) $(b)` is one echo with two
// arguments, not a command named `$`), while the bodies stay their own segments so every command inside is still checked.
// That return happens only for a "simple" body (isSimpleSubstitutionBody): after a `case` pattern `)` or a `)` inside `${...}` the
// rest of the body is still inside the substitution, so those keep the flat split and the words stay their own commands.
// Invariants: linear in the text length apart from a bounded arithmetic look-ahead; an unclosed quote runs to the end of the text.

const MAX_NESTING = 64; // `"$("$("...` deeper than this is read as plain text, so a hostile command cannot overflow the stack
const MAX_ARITHMETIC = 4096; // look-ahead for the `))` that closes `((`; a longer one is treated as nested parentheses
const HEREDOC_START = /<<-?[ \t]*/y;
const COMMENT_PREFIX = /[\s;&|(]/;

const NON_SIMPLE_BODY = /\bcase\b|\$\{|`|\$'|<<|#|<\(|>\(/; // a case pattern `)`, `${x#)}`, a comment, a heredoc: where a `)` may not end the substitution

/**
 * True when `body` (the text between a `$(` and the `)` that ended it in the scan) can only end at that `)`: no `case`, `${`, backtick,
 * comment, heredoc or process substitution; every `(` is a `$(` or `$((` and balanced inside the body; no quote is left open and no
 * `$(`/backtick hides inside double quotes. Anything unclear is "not simple", and the caller keeps the flat split (the safe, asking side).
 */
export function isSimpleSubstitutionBody(body) {
  if (NON_SIMPLE_BODY.test(body)) return false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') i++;
    else if (c === "'") {
      i = body.indexOf("'", i + 1);
      if (i === -1) return false;
    } else if (c === '"') {
      for (i++; i < body.length && body[i] !== '"'; i++) {
        if (body[i] === '\\') i++;
        else if (body[i] === '$' && body[i + 1] === '(') return false;
      }
      if (i >= body.length) return false;
    } else if (c === '(') {
      const dollar = body[i - 1] === '$' || (body[i - 1] === '(' && body[i - 2] === '$');
      if (!dollar) return false;
      depth++;
    } else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Marks a segment as fed by `|`; non-enumerable, so segments still compare equal to plain word lists. */
export const markPiped = (seg) => Object.defineProperty(seg, 'piped', { value: true, configurable: true });
// `NAME=(`, `NAME+=(`, `NAME[i]=(`: the list after it holds an array's elements, which are words, not a command
const ARRAY_ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/;
/** True when the `(` that follows the word `before` opens an array's element list (`files+=("$f")`). */
export const opensArrayList = (before) => ARRAY_ASSIGNMENT.test(before ?? '');
/** Marks a segment as an array's element list: the guard reads its words, but its first word is not a command word. */
export const markArrayList = (seg) => Object.defineProperty(seg, 'arrayList', { value: true, configurable: true });

/** The delimiter word after the `<<` at `at`, with quotes and backslashes removed from the WHOLE word (`"E"OF`, `E\\OF`, `'E'OF` all mean EOF), or undefined. */
function heredocDelimiter(text, at) {
  HEREDOC_START.lastIndex = at;
  if (!HEREDOC_START.test(text)) return undefined;
  let delimiter = '';
  for (let i = HEREDOC_START.lastIndex; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      delimiter += text.slice(i + 1, close === -1 ? text.length : close);
      i = close === -1 ? text.length : close;
    } else if (c === '\\') delimiter += text[++i] ?? '';
    else if (/[\s;|&()<>]/.test(c)) break;
    else delimiter += c;
  }
  return delimiter === '' ? undefined : delimiter;
}

/** Index after the `))` closing an arithmetic expression whose `((` ended before `from`, or -1 (it is `( (subshell) )` instead). */
function arithmeticEnd(text, from) {
  let depth = 0;
  const limit = Math.min(text.length, from + MAX_ARITHMETIC);
  for (let i = from; i < limit; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      if (depth === 0) return text[i + 1] === ')' ? i + 2 : -1;
      depth--;
    }
  }
  return -1;
}

/** Index after the `'` closing a `$'...'` string starting after `from` (a backslash escapes the next character). */
function ansiCEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i + 1;
  }
  return text.length;
}

/** Index after the line that holds only `delimiter` (surrounding blanks allowed), searching from `from`; -1 when there is none. */
function terminatorEnd(state, delimiter, from) {
  if (state.missing.has(delimiter)) return -1;
  const { text } = state;
  for (let at = from; at < text.length; ) {
    const newline = text.indexOf('\n', at);
    const end = newline === -1 ? text.length : newline;
    if (text.slice(at, end).trim() === delimiter) return newline === -1 ? text.length : newline + 1;
    at = end + 1;
  }
  state.missing.add(delimiter); // a later search starts further on, so it cannot succeed either
  return -1;
}

/** Called with the index after a newline: drops the bodies of the heredocs opened on that line and returns where scanning goes on. */
function skipHeredocBodies(state, from) {
  if (state.pending.length === 0) return from;
  let position = from;
  for (const delimiter of state.pending.splice(0)) {
    position = terminatorEnd(state, delimiter, position);
    if (position === -1) return from; // no terminator: the text is not a heredoc body, check it as commands
  }
  state.removed.push([from, position]);
  return position;
}

/** Index after the double-quoted text starting at `from` (just past the opening quote); collects `$(...)`/backtick bodies in `nested`. */
function skipDoubleQuoted(state, from, nested) {
  const { text } = state;
  for (let i = from; i < text.length; ) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if ((c === '$' && text[i + 1] === '(') || c === '`') {
      if (state.depth >= MAX_NESTING) {
        i++;
        continue;
      }
      if (c === '`') {
        state.depth++;
        const sub = walk(state, i + 1, '`');
        state.depth--;
        nested.push(text.slice(i + 1, sub.closed ? sub.end - 1 : sub.end));
        i = sub.end;
        continue;
      }
      const arithmetic = text[i + 2] === '(' ? arithmeticEnd(text, i + 3) : -1;
      if (arithmetic !== -1) {
        i = arithmetic;
        continue;
      }
      state.depth++;
      const sub = walk(state, i + 2, ')');
      state.depth--;
      nested.push(text.slice(i + 2, sub.closed ? sub.end - 1 : sub.end));
      i = sub.end;
    } else i++;
  }
  return text.length;
}

/**
 * Scans commands from `start` until the `closer` (`)` of a `$(`, a backtick) or the end of the text.
 * @returns {{segs: string[][], nested: string[], end: number, closed: boolean}} end is the index after the closer
 */
function walk(state, start, closer) {
  const { text } = state;
  const segs = [[]];
  const nested = [];
  const opened = []; // per open `(`: {outer, at} (the segment holding its `$`, and where it is) when it starts a substitution, else null
  let current = segs[0];
  let word = -1;
  let depth = 0;
  const begin = (at) => {
    if (word === -1) word = at;
  };
  const endWord = (to) => {
    if (word !== -1) current.push(text.slice(word, to));
    word = -1;
  };
  const split = (at, piped = false) => {
    endWord(at);
    if (current.length > 0) {
      current = piped ? markPiped([]) : [];
      segs.push(current);
    } else if (piped) markPiped(current); // `a |<newline> b`: the empty segment keeps its flag
  };
  let i = start;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === ' ' || c === '\t') {
      endWord(i);
      i++;
    } else if (c === '\n') {
      split(i);
      i = skipHeredocBodies(state, i + 1);
    } else if (c === '\\') {
      begin(i);
      i += 2;
    } else if (c === "'") {
      begin(i);
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
    } else if (c === '$' && next === "'") {
      begin(i);
      i = ansiCEnd(text, i + 2);
    } else if (c === '"') {
      begin(i);
      i = skipDoubleQuoted(state, i + 1, nested);
    } else if (c === '(' && next === '(' && arithmeticEnd(text, i + 2) !== -1) {
      if (text[i - 1] !== '$') endWord(i); // `((expr))` is a command that runs nothing; `$((expr))` stays part of its word
      i = arithmeticEnd(text, i + 2);
    } else if (c === '(') {
      endWord(i);
      opened.push(text[i - 1] === '$' && text[i - 2] !== '\\' ? { outer: current, at: i } : null);
      const arrayList = text[i - 1] === '=' && opensArrayList(current.at(-1));
      split(i);
      if (arrayList) markArrayList(current);
      if (closer === ')') depth++;
      i++;
    } else if (c === ')' && closer === ')' && depth === 0) {
      endWord(i);
      return { segs, nested, end: i + 1, closed: true };
    } else if (c === ')') {
      split(i);
      if (closer === ')') depth--;
      const sub = opened.pop();
      if (sub && isSimpleSubstitutionBody(text.slice(sub.at + 1, i))) current = sub.outer;
      i++;
    } else if (c === '`' && closer === '`') {
      endWord(i);
      return { segs, nested, end: i + 1, closed: true };
    } else if (c === '`' || c === ';') {
      if (c === '`' && word === -1 && current.length === 0) current.push('$'); // `` `cmd` `` as the command word, like `$(cmd)`
      split(i);
      i++;
    } else if (c === '#' && word === -1 && (i === start || COMMENT_PREFIX.test(text[i - 1]))) {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline;
    } else if (c === '|' && text[i - 1] !== '>') {
      const double = next === '|';
      split(i, !double);
      i += double || next === '&' ? 2 : 1;
    } else if (c === '&' && text[i - 1] !== '>' && text[i - 1] !== '<' && next !== '>') {
      split(i);
      i += next === '&' ? 2 : 1;
    } else if (c === '<' && next === '<') {
      begin(i);
      if (text[i + 2] === '<') i += 3; // here-string
      else {
        const delimiter = heredocDelimiter(text, i);
        if (delimiter !== undefined) state.pending.push(delimiter);
        i += 2;
      }
    } else {
      begin(i);
      i++;
    }
  }
  endWord(text.length);
  return { segs, nested, end: text.length, closed: false };
}

/** Text without the index ranges in `removed` (ascending, non-overlapping). */
function withoutRanges(text, removed) {
  let out = '';
  let at = 0;
  for (const [from, to] of removed) {
    out += text.slice(at, from);
    at = to;
  }
  return out + text.slice(at);
}

/**
 * @param {string} text a command line (may span lines)
 * @returns {{rawSegs: string[][], nested: string[], stripped: string}} see the file header
 */
export function lexShell(text) {
  const state = { text, pending: [], removed: [], missing: new Set(), depth: 0 };
  const { segs, nested } = walk(state, 0, null);
  return { rawSegs: segs.filter((seg) => seg.length), nested, stripped: withoutRanges(text, state.removed) };
}
