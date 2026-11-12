// Pure shell-text parsing for pre-bash-guard: no I/O, never evaluates anything.
// Exports: tokenize(command) -> {segs, nested}; segments(command) -> string[][]; stripHeredocs(command);
// parseArgs(args, spec) -> {files, target}; stripOutputRedirects(words); GIT_TOPLEVEL_WORD; unquote, basenameOf, flagsOf.
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
// output redirection: `>f`, `>>f`, `2>f`, `&>f`, `>|f`, `>&f`; `>&1` / `>&-` only duplicate or close a descriptor
const OUTPUT_REDIRECT = /^(?:\d*>&|&>>?|\d*>>?\|?)(.*)$/;
const DESCRIPTOR_TARGET = /^(\d+|-)$/;
const BARE_WORD_LINE = /^[ \t]*(\w+)[ \t]*$/;
// curl `-d @file`, `-F f=@file;type=x`, `-F f=<file`, `--data-urlencode name@file`
const CURL_DATA_FILE = /(?:^|=)[@<]([^;]+)|^[^=]*@([^;]+)/;

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

/** Drops output redirections (operator and target) from a word list: they write files, they never read `.env`. Input `<` stays. */
export function stripOutputRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const m = OUTPUT_REDIRECT.exec(words[i]);
    if (!m) out.push(words[i]);
    else if (m[1] === '' && i + 1 < words.length) i++; // the operator stands alone: its target is the next word
  }
  return out;
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

/** Option name -> where one of its values goes. Short names are `-x`, long names `--xyz`. */
export const optionKinds = (kind, ...names) => names.map((name) => [name, kind]);

// kind: value (skip 1) | value2 (skip 2) | pattern (skip 1, replaces the leading pattern word) | file (value is a file)
// | namedfile (name then file) | data (curl data value that may be `@file`) | target (cp -t DIR) | rest (ignore everything after)
function splitOption(arg, options) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    return { kind: options.get(name), attached: eq === -1 ? undefined : arg.slice(eq + 1) };
  }
  for (let i = 1; i < arg.length; i++) {
    const kind = options.get(`-${arg[i]}`);
    if (kind) return { kind, attached: arg.slice(i + 1) || undefined };
  }
  return {};
}

/**
 * Splits command arguments into the files they name. With `firstIsPattern` the first positional word is a pattern
 * or script (grep, sed, awk, jq), not a file, unless a pattern option (-e) or a file option (-f) supplied it.
 * @param {string[]} args words after the command
 * @param {{options?: Map<string,string>, firstIsPattern?: boolean, optionFilesOnly?: boolean}} spec optionFilesOnly: bare words
 *   are not files (curl URLs), only option values are
 * @returns {{files: string[], target: boolean}} target: a `-t DIR` option was given (all positionals are sources)
 */
export function parseArgs(args, { options = new Map(), firstIsPattern = false, optionFilesOnly = false } = {}) {
  const files = [];
  let target = false;
  let needPattern = firstIsPattern;
  const positional = (word) => {
    if (needPattern) needPattern = false;
    else if (!optionFilesOnly) files.push(word);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      args.slice(i + 1).forEach(positional);
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional(arg);
      continue;
    }
    const { kind, attached } = splitOption(arg, options);
    if (kind === 'rest') break;
    if (kind === 'target') target = true;
    if (kind === 'pattern' || kind === 'file') needPattern = false;
    if (kind === 'value2' || kind === 'namedfile') {
      const second = attached === undefined ? args[(i += 2)] : args[(i += 1)];
      if (kind === 'namedfile' && second !== undefined) files.push(second);
    } else if (kind) {
      const value = attached ?? args[++i];
      if (kind === 'file' && value !== undefined) files.push(value);
      if (kind === 'data' && value !== undefined) {
        const m = CURL_DATA_FILE.exec(value);
        if (m) files.push(m[1] ?? m[2]);
      }
    }
  }
  return { files, target };
}
