// Pure shell-text parsing for pre-bash-guard: no I/O, never evaluates anything.
// Exports: tokenize(command) -> {segs, nested}; segments(command) -> string[][]; stripHeredocs(command);
// GIT_TOPLEVEL_WORD; MKTEMP_WORD; QUOTED_MARK; lex(command) (same shape as tokenize, from shell-lexer.mjs); unquote, basenameOf, flagsOf;
// backtickAssignedNames(command); DECLARERS.
// Unquoted brace expressions are expanded the way bash does (`rm {-rf,x}` is `rm -rf x`), never in an assignment in front of the command;
// a segment flags the words whose braces cannot be listed (`.unlistedBraces`) and those holding a `$NAME` outside quotes (`.bareWords`),
// and keeps the operators that came before its first word (`.join`: `&&`, `;`, `(`, `)&&` ...; lib/cd-folder.mjs reads it).
// Words are unquoted the way a shell does: an unquoted backslash escapes the next character (`pu\sh` is `push`, `\/` is `/`,
// `\;` is a literal `;` word, a backslash-newline vanishes); inside double quotes a backslash only escapes `\ " $ \``.
// A quoted word that merely looks like a redirection (`">"`) gets QUOTED_MARK in front, so it stays a plain argument;
// an unquoted operator glued to a word (`.env>out`, `cat<.env`) is split off into its own word.
// A `$(...)` body is its own segment, but the words after its closing `)` continue the segment that held the `$`.
// Invariants: every pass is linear (or n log n) in the command length; a heredoc without a terminator line is left
// in place (so its body is still checked) rather than guessed at.

import { ANSI_C_WORD, decodeAnsiC } from './ansi-c.mjs';
import { expandRawBraces, hasUnquotedReference } from './braces.mjs';
import { isSimpleSubstitutionBody, lexShell, markArrayList, markJoin, markPiped, opensArrayList } from './shell-lexer.mjs';

// Alternation order matters: `&&`/`||` first, then words (a word may be `&>` or follow `>`), then single separators.
const WORD = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|' + ANSI_C_WORD + '|\'[^\']*\'|\\\\[\\s\\S]|(?<=[<>])&|(?<=>)\\||&(?=>)|[^\\s;|&()`\\\\])+';
const TOKEN = new RegExp(`(&&|\\|\\|)|(${WORD})|(;|\\||\\n|&|\\(|\\)|\`)`, 'g');
const LINE_CONTINUATION_ONLY = /^(?:\\\r?\n)+$/;
const DOUBLE_QUOTE_ESCAPABLE = '\\"$`';
// `$(git rev-parse --show-toplevel)` and its backtick form: the project root, replaced by one word so `cd` can follow it
export const GIT_TOPLEVEL = /\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/g;

const REDIRECT_LIKE = /^(?:\d*[<>]|&>)/;
/** Prefix for a quoted word that only looks like a redirection (`">"`, `"2>"`): bash passes it on as a plain argument. */
export const QUOTED_MARK = '\u0001';

/** Stands in for `$(git rev-parse --show-toplevel)`; the `$` keeps it "unknown" for everything except `cd`. */
export const GIT_TOPLEVEL_WORD = '$__GIT_TOPLEVEL__';

/** Index of the `"` that closes the double-quoted text starting after `from`, or -1 when it is not closed. */
function closingDoubleQuote(word, from) {
  for (let i = from; i < word.length; i++) {
    if (word[i] === '\\') i++;
    else if (word[i] === '"') return i;
  }
  return -1;
}

/** Index of the `'` that closes the `$'...'` text starting after `from` (a backslash escapes the next character), or -1. */
function ansiCClose(word, from) {
  for (let i = from; i < word.length; i++) {
    if (word[i] === '\\') i++;
    else if (word[i] === "'") return i;
  }
  return -1;
}

/** Double-quoted text without its quotes: a backslash is kept unless it escapes `\`, `"`, `$` or a backtick (or a newline). */
function unescapeDoubleQuoted(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const next = text[i + 1];
    if (text[i] === '\\' && next === '\n') i++;
    else if (text[i] === '\\' && next !== undefined && DOUBLE_QUOTE_ESCAPABLE.includes(next)) out += text[++i];
    else out += text[i];
  }
  return out;
}

/** Raw word -> the text the shell passes on: quotes removed, unquoted backslash escapes resolved (`r\m` -> `rm`). Never evaluates. */
export function unquote(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const ansi = c === '$' && word[i + 1] === "'";
    const localized = c === '$' && word[i + 1] === '"'; // `$"text"` is a double-quoted word
    if (localized) continue;
    const close = ansi ? ansiCClose(word, i + 2) : c === "'" ? word.indexOf("'", i + 1) : c === '"' ? closingDoubleQuote(word, i + 1) : -1;
    if (ansi && close !== -1) {
      out += decodeAnsiC(word.slice(i + 2, close));
      i = close;
    } else if (close !== -1) {
      out += c === "'" ? word.slice(i + 1, close) : unescapeDoubleQuoted(word.slice(i + 1, close));
      i = close;
    } else if (c === '\\' && i + 1 < word.length) {
      i++;
      if (word[i] !== '\n') out += word[i];
    } else out += c;
  }
  return out;
}
export const basenameOf = (path) => path.split(/[\\/]/).pop();
/** Unquoted word text, marked with QUOTED_MARK when its leading redirect characters came from inside quotes. */
const wordOf = (raw) => {
  const word = unquote(raw);
  return REDIRECT_LIKE.test(word) && !REDIRECT_LIKE.test(raw) ? QUOTED_MARK + word : word;
};

/** `.env>out` -> [`.env`, `>out`], `cat<.env` -> [`cat`, `<.env`]; an operator at the start (or after a file descriptor number) stays put. */
function splitAttachedRedirect(raw) {
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quote !== "'") i++; // an escaped character is data (`\>`, `\"`); inside `$'...'` (quote `$`) too
    else if (quote) quote = c === (quote === '$' ? "'" : quote) ? '' : quote;
    else if (c === '$' && raw[i + 1] === "'") {
      quote = '$';
      i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '<' || c === '>') {
      const at = c === '>' && raw[i - 1] === '&' ? i - 1 : i; // `&>` is one operator
      return /^\d*$/.test(raw.slice(0, at)) ? [raw] : [raw.slice(0, at), raw.slice(at)];
    }
  }
  return [raw];
}

export const flagsOf = (args) => args.filter((a) => a.startsWith('-'));

/** `$(pwd)` is the working directory: one word, so `rm -rf $(pwd)/dist` is judged like `$PWD/dist`. */
const PWD_SUBSTITUTION = /\$\(\s*pwd\s*\)|`\s*pwd\s*`/g;
/** Stands in for `$(mktemp -d)` / `` `mktemp` `` (default location): a fresh directory inside the temp dir. rm-paths.mjs gives it a value. */
export const MKTEMP_WORD = '$__MKTEMP__';
const MKTEMP_SUBSTITUTION = /\$\(\s*mktemp\b([^)]*)\)|`\s*mktemp\b([^`]*)`/g;
const MKTEMP_LEAVES_TEMP = /[/~]|(?:^|\s)-p|--tmpdir=/; // an explicit directory or template can point anywhere
const mktempWord = (whole, paren = '', backtick = '') => (MKTEMP_LEAVES_TEMP.test(paren + backtick) ? whole : MKTEMP_WORD);
const prepare = (command) =>
  command.replace(GIT_TOPLEVEL, () => GIT_TOPLEVEL_WORD).replace(PWD_SUBSTITUTION, '$PWD').replace(MKTEMP_SUBSTITUTION, mktempWord);

// `NAME=` glued to an unquoted backtick (maybe after some text): both parsers end the word at the backtick, so the value is lost
const BACKTICK_ASSIGNMENT = /(?<![\w$]|\$\{)([A-Za-z_]\w*)\+?=[^\s;&|<>()`]*`/g;

/**
 * The names a command line assigns from a backtick substitution (`X=`cat f``): their values are unknown, as after `$(...)`, and not
 * the empty text the parsers leave. The substitutions prepare() reads (`pwd`, mktemp, the project root) stay known.
 */
export const backtickAssignedNames = (command) =>
  (command.includes('`') ? new Set([...prepare(command).matchAll(BACKTICK_ASSIGNMENT)].map(([, name]) => name)) : new Set()); // most text has none

/** Drops heredoc bodies (data, not commands) so prose lines are not read as `rm` or `git`; quotes, comments and `$((1<<X))` are respected. */
export const stripHeredocs = (command) => lexShell(command).stripped;

/** Builtins whose `NAME=value` words are assignments (bash still brace-expands them, zsh does not). Also read by lib/rm-paths.mjs. */
export const DECLARERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
// words after which the next word is still in front of the command (`! X=1 cmd`, `if X=1 cmd`), as lib/command-of.mjs KEYWORDS
const RESERVED_WORDS = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until']);
const ASSIGNMENT_WORD = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;

/** The raw words a segment word stands for after brace expansion (see wordsOfSegment), or null when they cannot be listed. */
function expandedPieces(piece, { leading, declaration }) {
  const assignment = ASSIGNMENT_WORD.test(piece);
  if (leading && assignment) return [piece]; // `X={a,b} cmd` and `X={a,b}`: bash and zsh keep the braces
  const expanded = expandRawBraces(piece);
  return expanded !== null && declaration && assignment && expanded.length > 1 ? [piece, ...expanded] : expanded;
}

/**
 * The raw words of one segment -> its unquoted words, keeping the segment's flags (`.piped`, `.arrayList`). Unquoted brace expressions
 * are expanded as bash does (lib/braces.mjs); after export/declare/local/readonly/typeset an assignment keeps its own word too, since zsh
 * does not expand it there. Two more flags: `.unlistedBraces` holds the indices of words whose braces cannot be listed (kept as written),
 * `.bareWords` those with a `$NAME` outside quotes, which bash splits into words at blanks.
 */
function wordsOfSegment(raws) {
  const words = [];
  const unlisted = [];
  const bare = new Set();
  const state = { leading: true, declaration: false };
  for (const piece of raws.filter((raw) => !LINE_CONTINUATION_ONLY.test(raw)).flatMap(splitAttachedRedirect)) {
    if (state.leading && !ASSIGNMENT_WORD.test(piece) && !RESERVED_WORDS.has(piece)) {
      state.leading = false;
      state.declaration = DECLARERS.has(basenameOf(unquote(piece)));
    }
    const pieces = expandedPieces(piece, state);
    if (pieces === null) unlisted.push(words.length);
    for (const word of pieces ?? [piece]) {
      if (hasUnquotedReference(word)) bare.add(words.length);
      words.push(wordOf(word));
    }
  }
  if (raws.piped === true) markPiped(words);
  if (raws.arrayList === true) markArrayList(words);
  if (raws.join !== undefined) markJoin(words, raws.join);
  if (unlisted.length > 0) Object.defineProperty(words, 'unlistedBraces', { value: unlisted });
  if (bare.size > 0) Object.defineProperty(words, 'bareWords', { value: bare });
  return words;
}

/** Starts a new segment after `current`; `piped` marks one fed by `|` (an empty segment is reused, so `a |<newline> b` stays piped). Returns the segment to fill next. */
function startSegment(segs, current, piped) {
  if (current.length > 0) {
    const next = piped ? markPiped([]) : [];
    segs.push(next);
    return next;
  }
  return piped ? markPiped(current) : current;
}

/** Command text -> `{ segs, nested }`: segs are lists of unquoted words (`.piped` when a `|` fed it); nested are `$(...)`/backtick bodies found inside double quotes. */
export function tokenize(command) {
  const prepared = prepare(command);
  const { stripped, nested } = lexShell(prepared);
  const segs = [[]];
  const opened = []; // per open `(`: {outer, at} (the segment holding its `$`, and where it is) when it starts a substitution, else null
  let current = segs[0];
  let joined = ''; // the operators since the last word: the join of the segment the next word opens
  for (const m of stripped.matchAll(TOKEN)) {
    if (m[2] !== undefined) {
      if (LINE_CONTINUATION_ONLY.test(m[2])) continue;
      if (current.length === 0) markJoin(current, joined);
      joined = '';
      current.push(m[2]); // raw words; wordsOfSegment unquotes them once the segment is whole
      continue;
    }
    joined += m[0];
    if (m[3] === '(') opened.push(stripped[m.index - 1] === '$' && stripped[m.index - 2] !== '\\' ? { outer: current, at: m.index } : null);
    const arrayList = m[3] === '(' && stripped[m.index - 1] === '=' && opensArrayList(current.at(-1));
    current = startSegment(segs, current, m[3] === '|');
    if (arrayList) markArrayList(current);
    // the words after the `)` closing a simple `$(` belong to the segment that held the `$` (`echo $(a) $(b)`: one echo, not a command `$`)
    if (m[3] === ')') {
      const sub = opened.pop();
      if (sub && isSimpleSubstitutionBody(stripped.slice(sub.at + 1, m.index))) current = sub.outer;
    }
  }
  return { segs: segs.filter((s) => s.length).map(wordsOfSegment), nested };
}

/** Same result shape as tokenize, from the character-level lexer: the independent second parse behind the guard's raw-text backstop. */
export function lex(command) {
  const { rawSegs, nested } = lexShell(prepare(command));
  return { segs: rawSegs.map(wordsOfSegment).filter((s) => s.length), nested };
}

/** Command text -> list of segments, each a list of unquoted-word tokens (adjacent quoted parts joined, operators split). */
export function segments(command) {
  return tokenize(command).segs;
}
