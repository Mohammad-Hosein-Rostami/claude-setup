// Data is not a command: a dangerous word inside a SINGLE-QUOTED argument of a program that never runs its arguments does not make the raw-text
// rule (raw-risk.mjs) ask. Exports: withoutInertArguments(text) -> text with those quoted arguments emptied (`'rm -rf /x'` -> `''`).
// Allowlist (each entry has a test in tests/risky-word-data.test.mjs): echo, printf (not with -v, which fills a variable), grep, rg (not with --pre / --hostname-bin, which run a
// command), jq, sed whose script only substitutes or prints (no e or w, see sedScriptIsPlain; no -i), `git log` (not with --output). `git commit -m` is already data
// through lib/message-text.mjs. Everything else stays as written, among them shells, interpreters, eval, ssh, xargs, env, sudo, watch, flock,
// tmux, docker/kubectl exec, parallel, `git rebase --exec` and `find -exec`.
// A quoted argument is emptied only when ALL of these hold, else the text comes back unchanged (the safe, asking side):
//   - the command word is a bare allowlisted word (not quoted, no path), at the top level: not inside `$(...)`, backticks or `( )`, because
//     the output of a substitution can be run (`sh -c "$(echo 'rm -rf /x')"`);
//   - the statement is not piped onward; the whole line writes no file (a later `sh file` could run it: any `>` except `>/dev/null` and `>&N`),
//     has no pipe into a stage that is not a reader (`... | sh`, `| tee f`) and no pipe out of a group or loop (`} | tee f`, `done | sed w`), no `<<`,
//     `<(`, `>(`, `$'`, `${`, a `$(` or backtick inside double quotes, `case`, `eval`, `source`, `.`, `alias`, `function`, `trap`, `()`, `PATH=`
//     or another variable that changes what runs, and no carriage return (the shell may read quotes or comments differently from this tokenizer);
//   - the argument is one whole single-quoted word, optionally after `--flag=`; a double-quoted or mixed word is left alone.
// Quotes are read like the shell reads them outside heredocs: `\x`, `'..'`, `".."` (opaque, never emptied), comments; a quote that never closes
// stops everything. The caller (raw-risk.mjs) does not call this when the command holds a `$'...'` word, whose decoded text can hold a quote the
// shell does not read as one. Pure, no I/O; linear in the text length.
import { KEYWORDS } from './command-of.mjs';

const DATA_PROGRAMS = new Set(['echo', 'printf', 'grep', 'rg', 'jq', 'sed']);
// stages that may follow a `|`: the data programs plus readers that write nothing; anything else may run or store what it reads
const DATA_STAGES = new Set([...DATA_PROGRAMS, 'cat', 'head', 'tail', 'wc', 'cut', 'tr']);
const RG_RUNS_A_COMMAND = /^--(?:pre|hostname-bin)(?:=|$)/;
const BAIL_OUT = /<<|<\(|>\(|\r|\$'/;
// words that define or run what a later word means: a function or alias named `echo`, a sourced file, a case pattern that ends a `$(` early
const BAIL_WORDS = new Set(['case', 'esac', 'eval', 'source', '.', 'alias', 'function', 'trap', 'coproc']);
// a variable that changes which program or library runs (`PATH=./bin:$PATH grep ...`)
const CHANGES_WHAT_RUNS = /^(?:PATH|BASH_ENV|ENV|IFS|PAGER|LD_\w+|DYLD_\w+|GIT_\w+)=/;
const CLOSERS = new Set(['}', 'done', 'fi', 'esac']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const LONG_FLAG_VALUE = /^--[\w-]+=$/;
const SED_WRITES_FILES = /^(?:-[A-Za-z]*i|--i)/; // -i, -ni, -i.bak, --in-place and its abbreviations
const GIT_LOG_WRITES_FILES = /^--ou/; // --output and its abbreviations (git takes any unique prefix)
const HARMLESS_REDIRECT = />{1,2}(?:&[\d-]|[ \t]*\/dev\/null(?![\w./-]))/y; // to a descriptor or /dev/null; any other `>` may write a file
const COMMENT_BEFORE = /[\s;&|()<>]/; // the characters after which the shell starts a comment at `#`

/** True when a sed script only substitutes (`s/x/y/` with flags g p i I and digits) or prints, deletes or quits, so it cannot run or write anything. */
function sedScriptIsPlain(script) {
  let i = 0;
  const skipSpace = () => { while (i < script.length && /[\s;]/.test(script[i])) i++; };
  const skipSection = (delimiter) => { // up to and past the next unescaped delimiter; false when there is none
    while (i < script.length) {
      if (script[i] === '\\') i += 2;
      else if (script[i++] === delimiter) return true;
    }
    return false;
  };
  skipSpace();
  while (i < script.length) {
    if (script[i] === '/') { i++; if (!skipSection('/')) return false; } // an address `/re/`
    else if (/[\d$]/.test(script[i])) while (i < script.length && /[\d$,]/.test(script[i])) i++;
    if (script[i] === '!') i++;
    if (/[pdq]/.test(script[i] ?? '')) i++;
    else if (script[i] === 's' && i + 1 < script.length && /[^\w\s\\]/.test(script[i + 1])) {
      const delimiter = script[i + 1];
      i += 2;
      if (!skipSection(delimiter) || !skipSection(delimiter)) return false;
      while (/[gpiI\d]/.test(script[i] ?? '')) i++;
    } else return false;
    skipSpace();
  }
  return true;
}

/**
 * Index of the `"` that closes the double-quoted text opened at `start`; -1 when it never closes or the text inside may nest quotes the shell reads
 * differently: a `${` (a default value can hold quotes), or a `$(` or backtick that the first `"` cuts in two (`"$(sh -c "x")"`: unbalanced).
 */
function plainDoubleQuoteEnd(text, start) {
  let end = start + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
  if (end >= text.length) return -1;
  const inside = text.slice(start + 1, end).replace(/\\[\s\S]/g, '');
  const count = (char) => inside.split(char).length - 1;
  return inside.includes('${') || count('(') !== count(')') || count('`') % 2 === 1 ? -1 : end;
}

/** The separator that starts at `text[i]` (`|`, `|&`, `||`, `;`, newline, `&`, `&&`) as `{type, length}`, or undefined. */
function separatorAt(text, i) {
  const char = text[i];
  const next = text[i + 1];
  if (char === '|') return { type: next === '|' ? 'stop' : 'pipe', length: next === '|' || next === '&' ? 2 : 1 };
  if (char === ';' || char === '\n') return { type: 'stop', length: 1 };
  if (char === '&' && !/[<>]/.test(text[i - 1] ?? '') && next !== '>') return { type: 'stop', length: next === '&' ? 2 : 1 };
  return undefined;
}

const OPAQUE = { kind: 'opaque' };

/** Index of the last character of the comment that starts at `text[start]`: the one before its newline. */
function commentEnd(text, start) {
  const lineEnd = text.indexOf('\n', start);
  return lineEnd === -1 ? text.length : lineEnd - 1;
}

/**
 * The piece of a word that starts at `text[i]` when it is quoted, escaped or a redirect: `{part, end}` (a word part) or `{plain, end}` (text kept as
 * plain), `end` being the index of its last character; null when the shell may read it differently from this tokenizer; undefined when it is none.
 */
function pieceAt(text, i) {
  const char = text[i];
  const next = text[i + 1];
  if (char === "'") {
    const end = text.indexOf("'", i + 1);
    return end === -1 ? null : { part: { kind: 'single', start: i, end: end + 1 }, end };
  }
  if (char === '"') {
    const end = plainDoubleQuoteEnd(text, i);
    return end === -1 ? null : { part: OPAQUE, end };
  }
  if (char === '\\') return next === '`' ? null : { part: OPAQUE, end: i + 1 }; // an escaped backtick is a nested substitution
  if (char === '$' && next === '{') return null; // a default value may hold quotes that nest
  if (char !== '>') return undefined;
  HARMLESS_REDIRECT.lastIndex = i;
  const redirect = HARMLESS_REDIRECT.exec(text);
  return redirect === null ? null : { plain: redirect[0], end: i + redirect[0].length - 1 }; // any other `>` may write a file
}

/** Tokens of the text: words (as parts: plain text, single-quoted range, opaque) and the separators `stop`, `pipe`, `open`, `close`. Null when unclear. */
function tokenize(text) {
  const tokens = [];
  let parts = [];
  const flush = () => { if (parts.length > 0) tokens.push({ type: 'word', parts }); parts = []; };
  const addPlain = (chars) => {
    if (parts.at(-1)?.kind === 'plain') parts.at(-1).text += chars;
    else parts.push({ kind: 'plain', text: chars });
  };
  const sub = []; // what each open `$(`, `(` or backtick was, innermost last
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const separator = separatorAt(text, i);
    const piece = separator === undefined ? pieceAt(text, i) : undefined;
    if (piece === null) return null;
    if (separator !== undefined) {
      flush();
      // a group or loop piped onward: this tokenizer does not tell which of its statements feed the pipe
      if (separator.type === 'pipe' && CLOSERS.has(plainText(tokens.at(-1)?.parts ?? []))) return null;
      tokens.push({ type: separator.type });
      i += separator.length - 1;
    } else if (piece !== undefined) {
      if (piece.plain === undefined) parts.push(piece.part);
      else addPlain(piece.plain);
      i = piece.end;
    } else if (char === '#' && parts.length === 0 && (i === 0 || COMMENT_BEFORE.test(text[i - 1]))) {
      i = commentEnd(text, i);
    } else if ((char === '$' && text[i + 1] === '(') || char === '(' || char === '`') {
      if (char === '`' && sub.at(-1) === '`') { sub.pop(); flush(); tokens.push({ type: 'close', resumes: true }); continue; }
      flush();
      sub.push(char === '(' ? '(' : char === '`' ? '`' : '$(');
      tokens.push({ type: 'open', resumes: char !== '(' });
      if (char === '$') i++;
    } else if (char === ')') {
      flush();
      tokens.push({ type: 'close', resumes: sub.pop() !== '(' });
    } else if (/[ \t]/.test(char)) flush();
    else addPlain(char);
  }
  flush();
  return tokens;
}

/** Statements `{words, nested, pipedIn, pipedOut}` from the tokens; the words after a closed `$(...)` go back to the statement that held it. */
function statementsOf(tokens) {
  const done = [];
  const outer = [];
  let current = { words: [], nested: false, pipedIn: false, pipedOut: false };
  const finish = (pipe) => {
    if (current.words.length > 0) done.push({ ...current, pipedOut: pipe });
    current = { words: [], nested: outer.length > 0, pipedIn: pipe };
  };
  for (const token of tokens) {
    if (token.type === 'word') current.words.push(token.parts);
    else if (token.type === 'open') {
      outer.push(token.resumes ? current : null);
      current = { words: [], nested: true, pipedIn: false, pipedOut: false };
    } else if (token.type === 'close') {
      if (current.words.length > 0) done.push({ ...current, pipedOut: false });
      current = outer.pop() ?? { words: [], nested: outer.length > 0, pipedIn: false, pipedOut: false };
    } else finish(token.type === 'pipe');
  }
  if (current.words.length > 0) done.push(current);
  return done;
}

/** The text of a word that is one plain run (no quotes or escapes), else undefined. */
function plainText(word) {
  return word.length === 1 && word[0].kind === 'plain' ? word[0].text : undefined;
}

/** The plain text a word starts with, even when quotes follow (`NAME="x"` starts with `NAME=`), else ''. */
const startText = (word) => (word[0]?.kind === 'plain' ? word[0].text : '');

/** Index of the command word (after keywords and `NAME=value` words), or -1. */
const commandIndex = (words) => words.findIndex((word) => {
  const text = plainText(word);
  return text === undefined || (!ASSIGNMENT.test(text) && !KEYWORDS.has(text));
});

/** The ranges (text offsets) of the single-quoted arguments of this statement that are data, or [] when the statement is not a data statement. */
function dataRanges(statement, text) {
  const { words } = statement;
  const at = commandIndex(words);
  const program = at === -1 ? undefined : plainText(words[at]);
  const args = words.slice(at + 1);
  const isGitLog = program === 'git' && plainText(args[0] ?? []) === 'log';
  if (statement.nested || statement.pipedOut || !(DATA_PROGRAMS.has(program) || isGitLog)) return [];
  const argText = args.map(startText);
  if (program === 'printf' && argText.some((word) => word.startsWith('-v'))) return []; // `printf -v VAR '...'` (also `-vVAR`) fills a variable that git or the shell may run
  if (program === 'rg' && argText.some((word) => RG_RUNS_A_COMMAND.test(word))) return [];
  if (program === 'sed' && argText.some((word) => SED_WRITES_FILES.test(word))) return [];
  if (isGitLog && argText.some((word) => GIT_LOG_WRITES_FILES.test(word))) return [];
  const ranges = [];
  for (const word of args) {
    const quoted = word.at(-1)?.kind === 'single' ? word.at(-1) : undefined;
    const prefixOk = word.length === 1 || (word.length === 2 && word[0].kind === 'plain' && LONG_FLAG_VALUE.test(word[0].text));
    if (quoted === undefined || !prefixOk) continue;
    if (program === 'sed' && !sedScriptIsPlain(text.slice(quoted.start + 1, quoted.end - 1))) return [];
    ranges.push([quoted.start + 1, quoted.end - 1]);
  }
  return ranges;
}

/** True when the line has a shape in which the quoted text may still run, or that this tokenizer may read differently from the shell. */
function mayRunQuotedText(tokens, statements) {
  const opensAndCloses = tokens.some((token, at) => token.type === 'open' && tokens[at + 1]?.type === 'close'); // `echo() { ...; }` or `$()`
  const words = statements.flatMap((statement) => statement.words);
  const runsWhatItReads = statements.some((statement) => {
    const at = commandIndex(statement.words);
    return statement.pipedIn && !DATA_STAGES.has(at === -1 ? '' : plainText(statement.words[at]) ?? '');
  });
  return opensAndCloses || runsWhatItReads || words.some((word) => BAIL_WORDS.has(plainText(word) ?? '') || CHANGES_WHAT_RUNS.test(startText(word)));
}

/**
 * @param {string} text command text (line continuations joined; the caller does not pass a command with a `$'...'` word)
 * @returns {string} the text with the contents of data arguments removed; unchanged when nothing qualifies or anything is unclear
 */
export function withoutInertArguments(text) {
  if (!text.includes("'") || BAIL_OUT.test(text)) return text;
  const tokens = tokenize(text);
  if (tokens === null) return text;
  const statements = statementsOf(tokens);
  if (mayRunQuotedText(tokens, statements)) return text;
  let out = '';
  let copied = 0;
  const ranges = statements.flatMap((statement) => dataRanges(statement, text)).sort((x, y) => x[0] - y[0]);
  for (const [start, end] of ranges) {
    out += text.slice(copied, start);
    copied = end;
  }
  return out + text.slice(copied);
}
