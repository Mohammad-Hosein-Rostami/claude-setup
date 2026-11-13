// Pure shell-text parsing for pre-bash-guard: no I/O, never evaluates anything.
// Exports: tokenize(command) -> {segs, nested}; segments(command) -> string[][]; stripHeredocs(command);
// GIT_TOPLEVEL_WORD; MKTEMP_WORD; QUOTED_MARK; lex(command) (same shape as tokenize, from shell-lexer.mjs); unquote, basenameOf, flagsOf.
// Words are unquoted the way a shell does: an unquoted backslash escapes the next character (`pu\sh` is `push`, `\/` is `/`,
// `\;` is a literal `;` word, a backslash-newline vanishes); inside double quotes a backslash only escapes `\ " $ \``.
// A quoted word that merely looks like a redirection (`">"`) gets QUOTED_MARK in front, so it stays a plain argument;
// an unquoted operator glued to a word (`.env>out`, `cat<.env`) is split off into its own word.
// Invariants: every pass is linear (or n log n) in the command length; a heredoc without a terminator line is left
// in place (so its body is still checked) rather than guessed at.

import { ANSI_C_WORD, decodeAnsiC } from './ansi-c.mjs';
import { lexShell, markPiped } from './shell-lexer.mjs';

// Alternation order matters: `&&`/`||` first, then words (a word may be `&>` or follow `>`), then single separators.
const WORD = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|' + ANSI_C_WORD + '|\'[^\']*\'|\\\\[\\s\\S]|(?<=[<>])&|(?<=>)\\||&(?=>)|[^\\s;|&()`\\\\])+';
const TOKEN = new RegExp(`(&&|\\|\\|)|(${WORD})|(;|\\||\\n|&|\\(|\\)|\`)`, 'g');
const LINE_CONTINUATION_ONLY = /^(?:\\\r?\n)+$/;
const DOUBLE_QUOTE_ESCAPABLE = '\\"$`';
// `$(git rev-parse --show-toplevel)` and its backtick form: the project root, replaced by one word so `cd` can follow it
const GIT_TOPLEVEL = /\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/g;

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

/** Drops heredoc bodies (data, not commands) so prose lines are not read as `rm` or `git`; quotes, comments and `$((1<<X))` are respected. */
export const stripHeredocs = (command) => lexShell(command).stripped;

/** Raw words -> unquoted words (continuation-only words vanish, attached redirects split off). */
const wordsOfRaw = (raws) => raws.filter((raw) => !LINE_CONTINUATION_ONLY.test(raw)).flatMap((raw) => splitAttachedRedirect(raw).map(wordOf));

/** Starts a new segment; `piped` marks one fed by `|` (an empty segment is reused, so `a |<newline> b` stays piped). */
function startSegment(segs, piped) {
  const current = segs.at(-1);
  if (current.length > 0) segs.push(piped ? markPiped([]) : []);
  else if (piped) markPiped(current);
}

/** Command text -> `{ segs, nested }`: segs are lists of unquoted words (`.piped` when a `|` fed it); nested are `$(...)`/backtick bodies found inside double quotes. */
export function tokenize(command) {
  const prepared = prepare(command);
  const { stripped, nested } = lexShell(prepared);
  const segs = [[]];
  for (const m of stripped.matchAll(TOKEN)) {
    if (m[2] === undefined) startSegment(segs, m[3] === '|');
    else segs.at(-1).push(...wordsOfRaw([m[2]]));
  }
  return { segs: segs.filter((s) => s.length), nested };
}

/** Same result shape as tokenize, from the character-level lexer: the independent second parse behind the guard's raw-text backstop. */
export function lex(command) {
  const { rawSegs, nested } = lexShell(prepare(command));
  const segs = rawSegs.map((raw) => (raw.piped ? markPiped(wordsOfRaw(raw)) : wordsOfRaw(raw))).filter((s) => s.length);
  return { segs, nested };
}

/** Command text -> list of segments, each a list of unquoted-word tokens (adjacent quoted parts joined, operators split). */
export function segments(command) {
  return tokenize(command).segs;
}
