// Pure shell-text parsing for pre-bash-guard: no I/O, never evaluates anything.
// Exports: tokenize(command) -> {segs, nested}; segments(command) -> string[][]; stripHeredocs(command);
// GIT_TOPLEVEL_WORD; QUOTED_MARK; unquote, basenameOf, flagsOf.
// A quoted word that merely looks like a redirection (`">"`) gets QUOTED_MARK in front, so it stays a plain argument;
// an unquoted operator glued to a word (`.env>out`, `cat<.env`) is split off into its own word.
// Invariants: every pass is linear (or n log n) in the command length; a heredoc without a terminator line is left
// in place (so its body is still checked) rather than guessed at.

// Alternation order matters: `&&`/`||` first, then words (a word may be `&>` or follow `>`), then single separators.
const WORD = '(?:"[^"]*"|\'[^\']*\'|(?<=[<>])&|(?<=>)\\||&(?=>)|[^\\s;|&()`])+';
const TOKEN = new RegExp(`(&&|\\|\\|)|(${WORD})|(;|\\||\\n|&|\\(|\\)|\`)`, 'g');
const QUOTED_PART = /"([^"]*)"|'([^']*)'/g;
const DOUBLE_QUOTED = /"([^"]*)"/g;
const DQ_SUBSTITUTION = /\$\(([^)]*)\)|`([^`]*)`/g;
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)-?[ \t]*(['"]?)(\w+)\1/g;
// `$(git rev-parse --show-toplevel)` and its backtick form: the project root, replaced by one word so `cd` can follow it
const GIT_TOPLEVEL = /\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/g;
const BARE_WORD_LINE = /^[ \t]*(\w+)[ \t]*$/;

const REDIRECT_LIKE = /^(?:\d*[<>]|&>)/;
/** Prefix for a quoted word that only looks like a redirection (`">"`, `"2>"`): bash passes it on as a plain argument. */
export const QUOTED_MARK = '\u0001';

/** Stands in for `$(git rev-parse --show-toplevel)`; the `$` keeps it "unknown" for everything except `cd`. */
export const GIT_TOPLEVEL_WORD = '$__GIT_TOPLEVEL__';

export const unquote = (word) => word.replace(QUOTED_PART, (_, double, single) => double ?? single);
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
    if (quote) quote = c === quote ? '' : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '<' || c === '>') {
      const at = c === '>' && raw[i - 1] === '&' ? i - 1 : i; // `&>` is one operator
      return /^\d*$/.test(raw.slice(0, at)) ? [raw] : [raw.slice(0, at), raw.slice(at)];
    }
  }
  return [raw];
}

export const flagsOf = (args) => args.filter((a) => a.startsWith('-'));

/** Index of the first entry of the ascending list `sorted` that is >= `min`, or -1. */
function firstAtLeast(sorted, min) {
  let lo = 0;
  let hi = sorted?.length ?? 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return sorted && lo < sorted.length ? sorted[lo] : -1;
}

/** Drops heredoc bodies (data, not commands) so prose lines are not read as `rm` or `git`. Linear: terminator lines are indexed once. */
export function stripHeredocs(command) {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const terminators = new Map();
  lines.forEach((line, i) => {
    const word = BARE_WORD_LINE.exec(line)?.[1];
    if (word === undefined) return;
    if (!terminators.has(word)) terminators.set(word, []);
    terminators.get(word).push(i);
  });
  const kept = [];
  for (let i = 0; i < lines.length; ) {
    kept.push(lines[i]);
    let next = i + 1;
    for (const [, , word] of lines[i].matchAll(HEREDOC_OPERATOR)) {
      const end = firstAtLeast(terminators.get(word), next);
      if (end === -1) break;
      next = end + 1;
    }
    i = next;
  }
  return kept.join('\n');
}

/** Command text -> `{ segs, nested }`: segs are lists of unquoted words; nested are `$(...)`/backtick bodies found inside double quotes. */
export function tokenize(command) {
  const segs = [[]];
  const nested = [];
  for (const m of stripHeredocs(command).replace(GIT_TOPLEVEL, () => GIT_TOPLEVEL_WORD).matchAll(TOKEN)) {
    if (m[2] === undefined) {
      segs.push([]);
      continue;
    }
    for (const raw of splitAttachedRedirect(m[2])) segs.at(-1).push(wordOf(raw));
    for (const [, body] of m[2].matchAll(DOUBLE_QUOTED)) {
      for (const sub of body.matchAll(DQ_SUBSTITUTION)) nested.push(sub[1] ?? sub[2]);
    }
  }
  return { segs: segs.filter((s) => s.length), nested };
}

/** Command text -> list of segments, each a list of unquoted-word tokens (adjacent quoted parts joined, operators split). */
export function segments(command) {
  return tokenize(command).segs;
}
