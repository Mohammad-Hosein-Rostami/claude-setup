// Data text of a Bash command: the parts that lib/secrets.mjs reads only for known token shapes and named secret variables, never with its
// context rules (an assignment, `Bearer x`, a header, a URL or query credential, a flag), whose hits there are program code.
// Exports: dataTextRemoved(text) -> the text the context rules read.
// Read by the shell's grammar on the raw text, never guessed (P4). Data is:
//   - the body of a quoted-delimiter heredoc (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) that a bare `cat` or `tee` (also behind `sudo`) reads in a
//     top-level statement that is not piped and holds no `$(`, backtick, `<(` or `>(`, and only while the rest of the command cannot run or read
//     it: every other statement starts with a QUIET_COMMANDS word and holds no substitution, every other body holds none either, and the text
//     outside the bodies redefines no command (an alias, a function, `hash`, `enable`) and sets no variable that picks what runs
//     (CHANGES_WHAT_RUNS of lib/inert-arguments.mjs: PATH=, BASH_ENV=, ENV=, ...). So a body that a later statement runs or reads (`bash x.sh`,
//     `sh run.sh`, `xargs curl < f`, `source f`), a body inside `{ }`, a loop or an `if` (their words are not quiet), and a body sent to a
//     descriptor or coprocess that `exec` or `coproc` pointed at a shell are all scanned whole.
//     Inside a data body, a line that assigns an upper-case variable (`API_TOKEN=x`, `export DB_PASSWORD=x`: the shape of a `.env` file, a shell
//     startup file or any file sourced later) stays in the text, so the assignment rules still read it.
//   - when the command has no data body: the single-quoted arguments of inert programs (lib/inert-arguments.mjs: `grep -n '...' f`).
// Anything this reader cannot pair the way the shell does (a quote or `)` that does not close, a missing terminator line, a carriage return)
// gives no data at all. Invariant: a body that runs is scanned whole. Pure, no I/O, linear in the text length.

import { CHANGES_WHAT_RUNS, withoutInertArguments } from './inert-arguments.mjs';

const HEREDOC_READERS = new Set(['cat', 'tee']);
// The only commands that may stand next to a data body: none of them runs a file, sources one or hands one to another program.
const QUIET_COMMANDS = new Set([...HEREDOC_READERS, 'cd', 'mkdir', 'touch', 'chmod', 'ls', 'pwd', 'echo', 'printf', 'wc', 'head', 'tail', 'true']);
const STATEMENT_RUNS_TEXT = /\$\(|`|[<>]\(/;
const REDEFINES_A_COMMAND = /\b(?:alias|function|enable|hash)\b|\(\s*\)/;
const WORD_SPLIT = /[\s;&|()<>`'"]+/; // shell words, with quotes taken off, so `"PATH=x"` is looked at too (the asking side)
const WORD_END = /[\s;&|()<>]/; // what ends a shell word, and after which a `#` starts a comment
const LINE_CONTINUATION = /\\\r?\n/g;
// An env-file or shell-startup assignment: an upper-case name at the line start, or any name after `export` / `declare -x` and the like.
const ENV_ASSIGNMENT_LINE = /^[ \t]*(?:(?:export|readonly|declare|typeset|local)(?:[ \t]+-[A-Za-z]+)*[ \t]+[A-Za-z_]\w*|[A-Z_][A-Z0-9_]*)=/;

/** The end of a heredoc delimiter word that starts at `start` (after `<<` or `<<-`): its text without quotes, whether any part was quoted. */
function heredocDelimiter(text, start) {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t') i++;
  let word = '';
  let quoted = false;
  for (; i < text.length && !WORD_END.test(text[i]); i++) {
    if (text[i] === "'" || text[i] === '"') {
      const close = text.indexOf(text[i], i + 1);
      if (close === -1) return null;
      word += text.slice(i + 1, close);
      i = close;
      quoted = true;
    } else if (text[i] === '\\') {
      word += text[++i] ?? '';
      quoted = true;
    } else word += text[i];
  }
  return word === '' ? null : { word, quoted, end: i };
}

/**
 * Reads the bodies of the pending heredocs, in order, from the line after the newline at `newline`; each body runs up to the first line that is
 * exactly its delimiter (leading tabs removed for `<<-`). Pushes { start, end, data } (end = where the terminator line starts) to `bodies`.
 * @returns {number} the index of the newline that ends the last terminator line (text.length when it ends the text), or -1 when one is missing
 */
function readBodies(text, newline, pending, bodies) {
  let lineStart = newline + 1;
  for (const heredoc of pending) {
    const start = lineStart;
    let line;
    do {
      if (lineStart > text.length) return -1;
      const found = text.indexOf('\n', lineStart);
      const lineEnd = found === -1 ? text.length : found;
      line = { start: lineStart, text: text.slice(lineStart, lineEnd) };
      lineStart = lineEnd + 1;
    } while ((heredoc.stripTabs ? line.text.replace(/^\t+/, '') : line.text) !== heredoc.word);
    bodies.push({ start, end: line.start, data: heredoc.data === true });
  }
  pending.length = 0;
  return lineStart - 1;
}

/** The command word of a statement (after a leading `sudo`); '' for an empty statement. */
function commandWord(statement) {
  const words = statement.replace(LINE_CONTINUATION, ' ').trim().split(/\s+/);
  return words[0] === 'sudo' ? words[1] ?? '' : words[0];
}

/** True when the statement (from its start up to the heredoc's `<<`, and whole) only stores or prints the body. */
function readsBodyAsData(before, statement) {
  return HEREDOC_READERS.has(commandWord(before)) && !STATEMENT_RUNS_TEXT.test(statement);
}

/** True when a statement next to a data body can neither run nor read it: empty, a comment, or a quiet command with no substitution. */
function isQuietStatement(statement) {
  const trimmed = statement.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return true;
  return QUIET_COMMANDS.has(commandWord(trimmed)) && !STATEMENT_RUNS_TEXT.test(trimmed);
}

/** A top-level `;`, `&`, `&&`, `|`, `||` or `|&` at i (not the `&` or `|` of a redirection such as `>&2`, `&>f`, `>|f`), else undefined. */
function separatorAt(text, i) {
  const [prev, char, next] = [text[i - 1], text[i], text[i + 1]];
  if (char === ';') return { length: 1, piped: false };
  if (char === '|' && prev !== '>') return next === '|' ? { length: 2, piped: false } : { length: next === '&' ? 2 : 1, piped: true };
  if (char === '&' && prev !== '>' && prev !== '<' && next !== '>') return { length: next === '&' ? 2 : 1, piped: false };
  return undefined;
}

/** One character inside double quotes, where only `\`, the closing quote, `$(` and a backtick count. Returns the last index it consumed. */
function doubleQuotedStep(text, i, open) {
  if (text[i] === '\\') return i + 1;
  if (text[i] === '"') open.pop();
  else if (text[i] === '`') open.push('`');
  else if (text[i] === '$' && text[i + 1] === '(') {
    open.push(')');
    return i + 1;
  }
  return i;
}

/** One unquoted character that is a quote, an escape, a comment or opens or closes `$(`, `(` or a backtick. Returns the last index it consumed, -1 when unreadable. */
function unquotedStep(text, i, open) {
  const char = text[i];
  if (char === '\\') return i + 1;
  if (char === "'") return text.indexOf("'", i + 1);
  if (char === '$' && text[i + 1] === "'") { // ANSI-C quoting: `\'` does not close it
    for (let at = i + 2; at < text.length; at++) if (text[at] === '\\') at++; else if (text[at] === "'") return at;
    return -1;
  }
  if (char === '"') open.push('"');
  else if (char === '$' && text[i + 1] === '(') {
    open.push(')');
    return i + 1;
  } else if (char === '(') open.push(')');
  else if (char === ')' || (char === '`' && open.at(-1) === '`')) {
    if (open.at(-1) !== char) return -1; // a `)` that closes nothing (a `case` pattern): not read further
    open.pop();
  } else if (char === '`') open.push('`');
  else if (char === '#' && (i === 0 || WORD_END.test(text[i - 1]))) {
    const lineEnd = text.indexOf('\n', i);
    return (lineEnd === -1 ? text.length : lineEnd) - 1; // the comment's own newline is read next
  }
  return i;
}

/**
 * Every heredoc body of the text, each marked data or not by its own statement (see the header), and every top-level statement's text
 * (bodies not included), read the way the shell reads the line.
 * @param {string} text command text
 * @returns {{ bodies: { start: number, end: number, data: boolean }[], statements: string[] } | null} in text order; null when the text cannot be read with certainty
 */
function heredocBodies(text) {
  if (text.includes('\r')) return null;
  const bodies = [];
  const statements = [];
  const pending = []; // heredocs opened on the current line, whose bodies start after its newline
  const open = []; // what each open `"`, `$(`, `(` or backtick waits for, innermost last
  let statementStart = 0;
  const endStatement = (end, piped) => {
    for (const heredoc of pending) heredoc.data ??= !piped && readsBodyAsData(text.slice(heredoc.statementStart, heredoc.at), text.slice(heredoc.statementStart, end));
    statements.push(text.slice(statementStart, end));
  };
  for (let i = 0; i < text.length; i++) {
    const top = open.length === 0;
    const separator = top ? separatorAt(text, i) : undefined;
    if (open.at(-1) === '"') i = doubleQuotedStep(text, i, open);
    else if (text.startsWith('<<<', i)) i += 2;
    else if (text.startsWith('<<', i)) {
      const stripTabs = text[i + 2] === '-';
      const delimiter = heredocDelimiter(text, i + (stripTabs ? 3 : 2));
      if (delimiter === null) return null;
      pending.push({ word: delimiter.word, stripTabs, at: i, statementStart, data: delimiter.quoted && top ? undefined : false });
      i = delimiter.end - 1;
    } else if (text[i] === '\n') {
      if (top) endStatement(i, false);
      if (pending.length > 0) i = readBodies(text, i, pending, bodies);
      if (i === -1) return null;
      if (top) statementStart = i + 1;
    } else if (separator !== undefined) {
      endStatement(i, separator.piped);
      i += separator.length - 1;
      statementStart = i + 1;
    } else if ((i = unquotedStep(text, i, open)) < 0) return null;
  }
  if (open.length > 0) return null;
  statements.push(text.slice(statementStart));
  return { bodies, statements };
}

/** The text with each { start, end } range (in text order, not overlapping) replaced by `replacement(range)`, in one linear pass. */
function withRangesReplaced(text, ranges, replacement = () => '') {
  let kept = '';
  let copied = 0;
  for (const range of ranges) {
    kept += text.slice(copied, range.start) + replacement(range);
    copied = range.end;
  }
  return kept + text.slice(copied);
}

/** True when nothing else in the command can run, read or redefine what reads the data bodies (see the header). */
function bodiesStayData(text, { bodies, statements }) {
  const outside = withRangesReplaced(text, bodies);
  const otherBodiesRun = bodies.some(({ start, end, data }) => !data && STATEMENT_RUNS_TEXT.test(text.slice(start, end)));
  return statements.every(isQuietStatement) && !otherBodiesRun && !REDEFINES_A_COMMAND.test(outside)
    && !outside.split(WORD_SPLIT).some((word) => CHANGES_WHAT_RUNS.test(word));
}

/** The env-file assignment lines of one body, which the assignment rules still read (see the header). */
function envAssignmentLines(text, { start, end }) {
  return text.slice(start, end).split('\n').filter((line) => ENV_ASSIGNMENT_LINE.test(line)).map((line) => `${line}\n`).join('');
}

/**
 * The text the context rules of lib/secrets.mjs read: the data heredoc bodies taken out (their env-file assignment lines kept), else the
 * single-quoted arguments of inert programs emptied (lib/inert-arguments.mjs, which reads no line with a heredoc or a `$'...'` word).
 * @param {string} text command text
 * @returns {string} the text without its data; unchanged when nothing is data or the line is unclear
 */
export function dataTextRemoved(text) {
  const read = heredocBodies(text);
  if (read === null) return text;
  const dataBodies = read.bodies.filter(({ data }) => data);
  if (dataBodies.length > 0) return bodiesStayData(text, read) ? withRangesReplaced(text, dataBodies, (body) => envAssignmentLines(text, body)) : text;
  if (text.includes("$'")) return text;
  const joined = text.replace(LINE_CONTINUATION, '');
  const emptied = withoutInertArguments(joined);
  return emptied === joined ? text : emptied;
}
