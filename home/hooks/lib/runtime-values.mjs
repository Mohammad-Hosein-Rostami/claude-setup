// Values a command line only gets when it runs, which the guard cannot read: arithmetic on them, and words filled in from them.
// Exports: everyDoubleParenIsArithmetic(line) -> boolean; arithmeticReasons(line) -> string[]; ARITHMETIC_REASON; RUNTIME_VALUE_REASON;
// readsRuntimeValue(words, line) -> boolean.
// - Arithmetic runs commands: bash evaluates a name's value as an expression again, so `C='a[$(cmd)]'; echo $(( C ))` runs cmd. A body of
//   `$((..))` or `((..))` is inert only when every operand is a number literal, `$#` `$?` `$$` `$!`, a length (`${#X}`, `${#A[@]}`), or a
//   name whose last assignment earlier on the line (outside quotes, not in a subshell, not a prefix of a command) is a number literal, and
//   that no `read`, `mapfile`, array, `printf -v`, `getopts` or other loop of the line assigns (`for i in 1 2` is a number). An assignment
//   `i=..` inside an inert body makes `i` a number (`for ((i=0; i<3; i++))`). Anything else (`$(cat a)`, `$X`, `a[1]`, quotes, an unknown
//   name) asks ARITHMETIC_REASON.
// - everyDoubleParenIsArithmetic: every `((` of the raw line opens a body that closes with `))` as bash reads it (outside quotes and
//   comments, `\(` and `\)` escaped), and no `( (` stands apart. lib/shell-hazards.mjs then reads a tokenizer segment joined by `((`
//   as data, not as a command word; anything unclear is false, so it judges the command word as before.
// - readsRuntimeValue: a word fed by `"$@"`, `$*`, `$1`, an array (`"${A[@]}"`, `$A` after `A=(..)`), `${!X}`, or a name `read`,
//   `mapfile` or `getopts` assigns: its words are known only at run time (`read X <<< "push --force"; git $X`). Only where the line
//   expands it outside single quotes. A name `printf -v` or a `for`/`select` loop assigns counts only unquoted, where bash splits it
//   (`for X in "push --force"; do git $X`); quoted it is one word (`git add "$f"`), and lib/git-run-values.mjs judges git-run values. A loop
//   over plain words is judged per value instead (lib/loop-values.mjs). Both reasons bounce once (lib/bounce-once.mjs), the retry asks.
// Scanning is linear in the line apart from a bounded look-ahead for the `))` (MAX_ARITHMETIC); a body longer than that, an unclosed
// quote, an unbalanced parenthesis or a `<<` that is not a heredoc makes the line unclear: every `((` then counts, whatever the quoting,
// and no assignment counts. Pure, no I/O.

export const ARITHMETIC_REASON = 'command too complex to check: arithmetic on text read at run time can run commands (bash evaluates '
  + '`a[$(cmd)]` inside $(( )) and (( ))); use number literals or variables set to a number on this line, or confirm';
export const RUNTIME_VALUE_REASON = 'command too complex to check: a word filled in at run time (read, an array, "$@", set --) in a command '
  + 'this guard checks, so its options and targets are hidden; write the words out';

const MAX_ARITHMETIC = 4096; // look-ahead for the `))` that closes a `((`, as in lib/shell-lexer.mjs; a longer body makes the line unclear
const WORD_START_BEFORE = /[\s;&|()!]/;
const ASSIGNMENT_AT = /([A-Za-z_]\w*)\+?=/y;
const VALUE_AT = /(?:"[^"]*"|'[^']*'|\\.|[^\s;&|()<>])*/y;
const NUMBER_VALUE = /^(["']?)-?\d+\1$/;
const STANDS_ALONE_AT = /[ \t]*(?:$|[;&|\n)]|[A-Za-z_]\w*\+?=)/y; // no command follows: not a `N=5 cmd` prefix
const HEREDOC_AT = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\([^\s;&|()<>]+)|([^\s;&|()<>'"]+))/y;
// one arithmetic token: blanks, numbers, specials and lengths, `${N}` / `$N` (group 1/2), a bare name (group 3), operators
const TOKEN = new RegExp([String.raw`\s+`, String.raw`0[xX][0-9a-fA-F]+`, String.raw`\d+#[0-9A-Za-z@_]+`, String.raw`\d+`,
  String.raw`\$\{#(?:[A-Za-z_]\w*(?:\[[@*]\])?|[@*])?\}`, String.raw`\$[#?$!]`, String.raw`\$\{[#?$!]\}`, String.raw`\$\{([A-Za-z_]\w*)\}`,
  String.raw`\$([A-Za-z_]\w*)`, String.raw`([A-Za-z_]\w*)`, String.raw`\*\*=?|<<=?|>>=?|&&|\|\||\+\+|--|[-+*/%&|^<>=!]=|[-+*/%<>&|^~!?:,;=()]`,
].join('|'), 'y');
const PLAIN_ASSIGNMENT_NEXT = /^\s*=(?!=)/;
const READ_INTO = /\b(?:read|mapfile|readarray|getopts)\b([^;&|\n]*)/g;
const PRINTF_INTO = /\bprintf\s+(?:-\w+\s+)*-v\s*([A-Za-z_]\w*)/g;
const ARRAY_INTO = /(?:^|[^\w$])([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=\(/g;
const ELEMENT_INTO = /(?:^|[^\w$])([A-Za-z_]\w*)\[[^\]]*\]\+?=/g;
const LOOP_INTO = /\b(for|select)\s+([A-Za-z_]\w*)(?:\s+in\s+([^;&|\n]*))?/g;
const NUMBER_WORD = /^(?:-?\d+|\{-?\d+\.\.-?\d+\})$/; // `for i in 1 2 {3..5}`: every value a number
// `$X`, `${X}`, `${!X}` (indirect, group 1), `$@`, `$*`, `$1`, `${A[@]}` (a subscript, group 3); `${#X}` is a length, a number
const REFERENCE = /\$(?:\{(!)?([A-Za-z_]\w*|[@*\d])(\[)?|([A-Za-z_]\w*|[@*\d]))/g;
const REFERENCE_AT = /\$\{?!?([A-Za-z_]\w*|[@*\d])/y;
const POSITIONAL_OR_LIST = /^[@*\d]$/;
const PLAIN_NAME = /^[A-Za-z_]\w*$/;

/** The `))` closing a `((` whose body starts at `from`: {to, end} (body end, index after the `))`), 'long', or undefined (`( (..) ..)`). */
function arithmeticClose(line, from) {
  let depth = 0;
  for (let j = from; j < line.length; j++) {
    if (j - from > MAX_ARITHMETIC) return 'long';
    const c = line[j];
    if (c === '\\') j++;
    else if (c === "'" || c === '"') j = quoteEnd(line, j);
    else if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (c === ')') return line[j + 1] === ')' ? { to: j, end: j + 2 } : undefined;
  }
  return undefined;
}

/** Index of the quote closing the one at `at` (a backslash escapes inside double quotes), or the line's end. */
function quoteEnd(line, at) {
  for (let j = at + 1; j < line.length; j++) {
    if (line[at] === '"' && line[j] === '\\') j++;
    else if (line[j] === line[at]) return j;
  }
  return line.length;
}

/** Records the body of the `((` at `at` (or reads it as two parentheses when it does not close with `))`); returns where to go on. */
function openParens(line, at, dollar, scan) {
  const close = line[at + 1] === '(' ? arithmeticClose(line, at + 2) : undefined;
  if (close === 'long') scan.unclear = true;
  if (close === undefined || close === 'long') {
    scan.stack.push(dollar ? 'cmd' : 'group');
    return at + 1;
  }
  scan.bodies.push({ opener: at, from: at + 2, to: close.to });
  return close.end;
}

/** Skips the heredoc bodies that start after the newline at `from - 1`; the `$((` of a body whose delimiter is not quoted are bodies too. */
function heredocBodies(line, from, heredocs, scan) {
  let at = from;
  for (const { strip, delimiter, expands } of heredocs) {
    const start = at;
    while (at < line.length) {
      const lineEnd = line.indexOf('\n', at) === -1 ? line.length : line.indexOf('\n', at);
      const text = line.slice(at, lineEnd);
      at = lineEnd + 1;
      if ((strip ? text.replace(/^\t+/, '') : text) === delimiter) break;
    }
    if (expands) everyDoubleParen(line, start, Math.min(at, line.length), scan, false);
  }
  return at;
}

/** Every `((` (or only `$((` when `bare` is false) in line[from, to), whatever the quoting: the unclear line's fallback, and heredoc bodies. */
function everyDoubleParen(line, from, to, scan, bare) {
  for (let i = from; i < to - 1; i++) {
    if (line[i] !== '(' || line[i + 1] !== '(' || (!bare && line[i - 1] !== '$')) continue;
    const close = arithmeticClose(line, i + 2);
    if (close === 'long') scan.unclear = true;
    else if (close !== undefined) scan.bodies.push({ opener: i, from: i + 2, to: close.to });
  }
}

/** One character outside double quotes (also inside `$(..)`); returns the next index. */
function scanUnquoted(line, i, scan) {
  const c = line[i];
  const wordStart = i === 0 || WORD_START_BEFORE.test(line[i - 1]);
  if (c === '\\') return i + 2;
  if (c === "'") return line.indexOf("'", i + 1) === -1 ? ((scan.unclear = true), line.length) : line.indexOf("'", i + 1) + 1;
  if (c === '$' && line[i + 1] === "'") return quoteEnd(line, i + 1) + 1;
  if (c === '"') return (scan.stack.push('dq'), i + 1);
  if (c === '#' && wordStart) return line.indexOf('\n', i) === -1 ? line.length : line.indexOf('\n', i);
  if (c === '$' && line[i + 1] === '(') return openParens(line, i + 1, true, scan);
  if (c === '(') return openParens(line, i, false, scan);
  if (c === ')') return (scan.stack.pop() === undefined && (scan.unclear = true), i + 1);
  if (c === '<' && line.startsWith('<<<', i)) return i + 3;
  if (c === '<' && line[i + 1] === '<') return heredocStart(line, i, scan);
  if (c === '\n' && scan.heredocs.length > 0) return heredocBodies(line, i + 1, scan.heredocs.splice(0), scan);
  ASSIGNMENT_AT.lastIndex = i;
  const assignment = wordStart ? ASSIGNMENT_AT.exec(line) : null;
  if (assignment === null) return i + 1;
  VALUE_AT.lastIndex = ASSIGNMENT_AT.lastIndex;
  const value = VALUE_AT.exec(line)?.[0] ?? '';
  STANDS_ALONE_AT.lastIndex = VALUE_AT.lastIndex;
  const numeric = scan.stack.length === 0 && NUMBER_VALUE.test(value) && STANDS_ALONE_AT.test(line);
  scan.assignments.push({ at: i, name: assignment[1], numeric });
  return ASSIGNMENT_AT.lastIndex;
}

/** Reads the `<<` at `i` as a heredoc start (its body is read at the next newline); anything else there makes the line unclear. */
function heredocStart(line, i, scan) {
  HEREDOC_AT.lastIndex = i;
  const m = HEREDOC_AT.exec(line);
  if (m === null) return ((scan.unclear = true), i + 2);
  scan.heredocs.push({ strip: m[1] === '-', delimiter: m[2] ?? m[3] ?? m[4] ?? m[5], expands: m[5] !== undefined });
  return HEREDOC_AT.lastIndex;
}

/** Notes the name a `$` at `i` expands (outside single quotes), so a `$@` the line only quotes is not read as one. */
function noteReference(line, i, scan) {
  REFERENCE_AT.lastIndex = i;
  const name = REFERENCE_AT.exec(line)?.[1];
  if (name !== undefined) scan.references.add(name);
}

/** The line as bash reads it: its arithmetic bodies and the assignments outside quotes, in order; `unclear` when it cannot tell. */
function scanLine(line) {
  const scan = { bodies: [], assignments: [], references: new Set(), stack: [], heredocs: [], unclear: false };
  for (let i = 0; i < line.length;) {
    if (line[i] === '$') noteReference(line, i, scan);
    if (scan.stack.at(-1) !== 'dq') i = scanUnquoted(line, i, scan);
    else if (line[i] === '\\') i += 2;
    else if (line[i] === '"') i = (scan.stack.pop(), i + 1);
    else if (line[i] === '$' && line[i + 1] === '(') i = openParens(line, i + 1, true, scan);
    else i += 1;
  }
  if (scan.stack.length > 0 || scan.heredocs.length > 0) scan.unclear = true;
  if (!scan.unclear) return scan;
  const fallback = { ...scan, bodies: [], assignments: [] };
  everyDoubleParen(line, 0, line.length, fallback, true);
  return fallback;
}

let lastLine; // the line read last and its scan: one line has a segment per arithmetic body, and both parsers ask about it
let lastScan;
const scanOf = (line) => (line === lastLine ? lastScan : ([lastLine, lastScan] = [line, scanLine(line)])[1]);

/**
 * @param {string} line one command line as written
 * @returns {boolean} true when every `((` of the line opens an arithmetic body that closes with `))` and nothing about it is unclear
 */
export function everyDoubleParenIsArithmetic(line) {
  if (/\\[()]/.test(line) || /\((?:\s|\\\n|#[^\n]*)+\(/.test(line)) return false; // escaped, or `( (`: two groups, joined as `((` all the same
  const scan = scanOf(line);
  const openers = new Set(scan.bodies.map((body) => body.opener));
  for (let i = line.indexOf('(('); i !== -1; i = line.indexOf('((', i + 1)) if (!openers.has(i)) return false;
  return !scan.unclear;
}

const namesIn = (line, pattern, group = 1) => [...line.matchAll(pattern)].map((m) => m[group]);
const wordsIn = (tail) => tail.split(/[\s'"]+/).filter((word) => PLAIN_NAME.test(word));

/** The names the line assigns from input (read, mapfile, getopts) or as arrays: their values are known only at run time. */
function runtimeNames(line) {
  return new Set([...namesIn(line, READ_INTO).flatMap(wordsIn), ...namesIn(line, ARRAY_INTO), ...namesIn(line, ELEMENT_INTO)]);
}

/** The last event (assignment) of `name` before `at`, or undefined. */
const lastEvent = (events, name, at) =>
  events.reduce((last, event) => (event.name === name && event.at < at && (last === undefined || event.at > last.at) ? event : last), undefined);

/** True when the body (line[from, to)) holds only numbers, specials, lengths and names that are numbers at that point (see the header). */
function isInert(line, { from, to }, events, notNumbers) {
  const body = line.slice(from, to);
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < body.length) {
    const at = from + TOKEN.lastIndex;
    const token = TOKEN.exec(body);
    if (token === null) return false;
    const name = token[1] ?? token[2] ?? token[3];
    if (name === undefined) continue;
    if (token[3] !== undefined && PLAIN_ASSIGNMENT_NEXT.test(body.slice(TOKEN.lastIndex))) events.push({ at, name, numeric: true });
    else if (notNumbers.has(name) || lastEvent(events, name, at)?.numeric !== true) return false;
  }
  return true;
}

/** Loop variables: a number at the loop when every value of a `for` list is one (`for i in 1 2`), else never a number on this line. */
function loopEvents(line, notNumbers) {
  return [...line.matchAll(LOOP_INTO)].flatMap(({ 1: keyword, 2: name, 3: list, index }) => {
    const values = (list ?? '').trim().split(/\s+/);
    if (keyword === 'for' && list !== undefined && values.every((value) => NUMBER_WORD.test(value))) return [{ at: index, name, numeric: true }];
    notNumbers.add(name);
    return [];
  });
}

/**
 * @param {string} line one command line as written (the guard calls it for every line it judges, nested scripts too)
 * @returns {string[]} [ARITHMETIC_REASON] when some arithmetic body is not inert (see the header), else []
 */
export function arithmeticReasons(line) {
  if (!line.includes('((')) return [];
  const scan = scanOf(line);
  const notNumbers = new Set([...runtimeNames(line), ...namesIn(line, PRINTF_INTO)]);
  const events = [...scan.assignments, ...loopEvents(line, notNumbers)];
  const bodies = [...scan.bodies].sort((x, y) => x.from - y.from);
  return bodies.every((body) => isInert(line, body, events, notNumbers)) ? [] : [ARITHMETIC_REASON];
}

/**
 * @param {string[]} words the words of one command after its command word, as written (quotes removed, `$NAME` kept)
 * @param {string} line the command line they came from
 * @returns {boolean} true when a word is filled in from a positional or list parameter, an array, an indirect `${!X}` or a name read at
 *   run time, and the line expands that name outside single quotes (`sh -c 'echo "$@"'` does not; the script is judged on its own); or,
 *   in an unquoted word (bash splits it), a name a `printf -v` or a `for`/`select` loop assigns (`for X in "push --force"; do git $X`)
 * @param {Set<number>} [unquoted] the indexes in `words` of the words written without quotes
 */
export function readsRuntimeValue(words, line, unquoted = new Set()) {
  if (!words.some((word) => word.includes('$'))) return false;
  const scan = scanOf(line);
  const names = runtimeNames(line);
  const splitNames = new Set([...namesIn(line, PRINTF_INTO), ...namesIn(line, LOOP_INTO, 2)]);
  const runtime = (at) => ([, indirect, braced, subscript, plain]) => {
    const name = braced ?? plain;
    const fromRunTime = indirect !== undefined || subscript !== undefined || POSITIONAL_OR_LIST.test(name) || names.has(name);
    return (fromRunTime || (unquoted.has(at) && splitNames.has(name))) && (scan.unclear || scan.references.has(name));
  };
  return words.some((word, at) => [...word.matchAll(REFERENCE)].some(runtime(at)));
}
