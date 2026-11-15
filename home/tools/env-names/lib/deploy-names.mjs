// Finds the environment variable names a deploy file mentions: Dockerfile ARG/ENV, compose `environment:` and `${NAME}`,
// GitHub workflow and GitLab CI `env:` keys with `secrets.NAME` / `vars.NAME`.
// Exports: scanDeploy(kind, text) -> { mentions: [{ name, line }], hidden }; deployKind(path) -> kind or null.
// Invariants: pure; only the name part of an assignment is captured, the value (even a quoted one holding `X=y`) is skipped
//   unread. Kinds: dockerfile, compose, workflow, gitlab. Output rule: a name is kept when it is a plain name (see
//   name-shape.mjs), or when it sits in a KEY position (`NAME:` of a YAML mapping, `${NAME`, `${{ secrets.NAME }}`) and has
//   at most 64 characters; never one taken from the left of `=` in a Dockerfile or a `- NAME=value` item unless plain.
//   Anything else is counted in `hidden`. Skipped as value text: Dockerfile heredoc bodies, YAML quoted values that continue over
//   several lines and block scalars; after a YAML quote that never closes no later name of the file is kept (counted in `hidden`). Mentions are sorted by line, then name.
import { MAX_NAME_LENGTH, isPlainName } from './name-shape.mjs';

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const NAME_AT_START = new RegExp(`^${NAME}`);
// `$${NAME}` is compose's escape for a literal `${NAME}`: not a substitution.
const SUBSTITUTION = new RegExp(`(?<!\\$)\\$\\{(${NAME})`, 'g');
// Only inside a `${{ ... }}` expression: the words secrets.X in a plain string are text, not a reference.
const CI_REFERENCE = new RegExp(`(?<=\\$\\{\\{[^}]*)\\b(?:secrets|vars)\\.(${NAME})`, 'g');
const LIST_ENTRY = new RegExp(`^-\\s+['"]?(${NAME})(?:=|['"]|\\s|$)`);
const BLOCK_OPENER = /^(\s*)([A-Za-z_-]+):\s*(?:#.*)?$/;
const INSTRUCTION = /^\s*(?:ARG|ENV)\s+(.*)$/i;
const HEREDOC_TAG = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g;
const BLOCK_KEYS = { compose: ['environment'], workflow: ['env'], gitlab: ['env', 'variables'] };

/** The kind of deploy file a relative posix path is, or null. */
export function deployKind(path) {
  const base = path.split('/').pop();
  if (/^Dockerfile/.test(base)) return 'dockerfile';
  if (/^(?:docker-)?compose.*\.ya?ml$/.test(base)) return 'compose';
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'workflow';
  return base === '.gitlab-ci.yml' ? 'gitlab' : null;
}

/** Index after the value that starts at `from`: runs to the next space outside quotes, honouring `\` escapes. */
function skipValue(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (quote !== null) quote = text[i] === quote ? null : quote;
    else if (text[i] === '"' || text[i] === "'") quote = text[i];
    else if (/\s/.test(text[i])) return i;
  }
  return text.length;
}

/** Names of `NAME=value NAME2="v w"` (ENV/ARG arguments) and of the legacy `NAME value` form; values are skipped unread. */
function assignmentNames(args) {
  const names = [];
  let at = 0;
  while (at < args.length) {
    const rest = args.slice(at).trimStart();
    at = args.length - rest.length;
    const name = NAME_AT_START.exec(rest)?.[0];
    if (name === undefined) break;
    const next = rest[name.length];
    if (next !== undefined && next !== '=' && !/\s/.test(next)) break;
    if (next === '=' || names.length === 0) names.push(name); // after the first word only `NAME=...` counts
    if (next !== '=') break; // `ENV NAME value`: the rest of the line is the value; a bare later word ends the scan
    at = skipValue(args, at + name.length + 1);
  }
  return names;
}

/** ENV and ARG instructions; a trailing backslash joins the next line, and the mention keeps the first line's number. */
function scanDockerfile(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    let joined = lines[i];
    const startLine = i + 1;
    while (joined.trimEnd().endsWith('\\') && i + 1 < lines.length) joined = joined.trimEnd().slice(0, -1) + lines[(i += 1)]; // Docker joins with no space
    const args = INSTRUCTION.exec(joined)?.[1];
    if (args !== undefined && !joined.trimStart().startsWith('#')) assignmentNames(args).forEach((name) => found.push({ name, line: startLine, keyed: false }));
    for (const [, tag] of joined.matchAll(HEREDOC_TAG)) {
      // A heredoc body is script or file text, not instructions: skip to the line that is the tag (tabs stripped for `<<-`).
      while (i + 1 < lines.length && lines[i + 1].replace(/^\t+/, '').trimEnd() !== tag) i += 1;
      i += 1;
    }
  }
  return found;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === '' || line.trimStart().startsWith('#');

const FLOW_OPENERS = '{[';
const FLOW_CLOSERS = '}]';
const QUOTE_BEFORE = /[\s{[,:]/;
// The key at the start of a block line: a name or a quoted name (map entry), captured for the name check.
const MAP_ENTRY = new RegExp(`^(?:"(${NAME})"|'(${NAME})'|(${NAME}))\\s*:(?:\\s|$)`);
// Any key (plain, dotted, quoted) that precedes a value on a block line.
const ANY_KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[\w.\-/]+)\s*:(?:\s+|$)/;

/**
 * Follows a YAML value over its text: `open` is { quote, depth }, the quote still open (`"` with backslash escapes, `'` with
 * `''` as a literal quote) and the depth of unclosed `{` / `[`. A fresh value (nothing open) is only a quote or flow collection
 * when it starts with one; plain text ends the scan at once. Mutates `open`.
 */
function followValue(open, text) {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (open.quote !== null) {
      if (open.quote === '"' && char === '\\') i += 1;
      else if (open.quote === "'" && char === "'" && text[i + 1] === "'") i += 1;
      else if (char === open.quote) open.quote = null;
    } else if ((char === '"' || char === "'") && (open.depth === 0 || QUOTE_BEFORE.test(text[i - 1] ?? ' '))) {
      open.quote = char;
    } else if (FLOW_OPENERS.includes(char)) {
      open.depth += 1;
    } else if (FLOW_CLOSERS.includes(char)) {
      open.depth = Math.max(0, open.depth - 1);
    }
    if (open.quote === null && open.depth === 0) return;
  }
}

/** The value of a block line (after `- ` and a key), trimmed; the text itself when it has no key. */
const valueOfLine = (text) => text.replace(/^-\s+/, '').replace(ANY_KEY, '').trim();
const isOpen = (open) => open.quote !== null || open.depth > 0;

/**
 * Entries under one `environment:`-style line at `from`: lines at the block's own indent are keys, deeper lines are not.
 * Every line is followed for open quotes and unclosed `{` / `[`, so a value that goes on over lines, a quoted value that starts on
 * the next line and a flow map never give a key. Returns the line (1-based) where a quote or bracket was left open, or 0.
 */
function scanBlock(lines, from, openerIndent, found) {
  let blockIndent = null;
  let openedAt = 0;
  const open = { quote: null, depth: 0 };
  for (let i = from; i < lines.length; i += 1) {
    if (isOpen(open) && (open.quote !== null || !isSkippable(lines[i]))) {
      followValue(open, lines[i].trim());
      continue;
    }
    if (isSkippable(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= openerIndent || (blockIndent !== null && indent < blockIndent)) break;
    blockIndent ??= indent;
    const text = lines[i].trim();
    const mapMatch = indent === blockIndent ? MAP_ENTRY.exec(text) : null;
    const mapName = mapMatch?.slice(1).find((group) => group !== undefined);
    const name = mapName ?? (indent === blockIndent ? LIST_ENTRY.exec(text)?.[1] : undefined);
    if (name !== undefined) found.push({ name, line: i + 1, keyed: mapName !== undefined });
    followValue(open, valueOfLine(text));
    openedAt = i + 1;
  }
  return isOpen(open) ? openedAt : 0;
}

/**
 * Entries of the blocks under `keys: ` lines (see scanBlock). `unclosedAt` is the first line where a quote or bracket never
 * closed (names after it are not trusted), or Infinity.
 */
function blockEntries(lines, keys) {
  const found = [];
  let unclosedAt = Infinity;
  lines.forEach((line, index) => {
    const opener = BLOCK_OPENER.exec(line);
    if (opener === null || !keys.includes(opener[2])) return;
    const openedAt = scanBlock(lines, index + 1, indentOf(line), found);
    if (openedAt > 0) unclosedAt = Math.min(unclosedAt, openedAt);
  });
  return { found, unclosedAt };
}

/** Every match of `pattern` (first capture group is the name) on lines that are not comments. */
function patternMentions(lines, pattern) {
  const found = [];
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return;
    for (const match of line.matchAll(pattern)) found.push({ name: match[1], line: index + 1, keyed: true });
  });
  return found;
}

/**
 * @param {'dockerfile'|'compose'|'workflow'|'gitlab'} kind
 * @param {string} text file content
 * @returns {{ mentions: { name: string, line: number }[], hidden: number }} kept names sorted by line, then name; count of names left out
 */
export function scanDeploy(kind, text) {
  const lines = text.split(/\r\n|\r|\n/);
  let found;
  let unclosedAt = Infinity;
  if (kind === 'dockerfile') {
    found = scanDockerfile(lines);
  } else {
    const blocks = blockEntries(lines, BLOCK_KEYS[kind]);
    unclosedAt = blocks.unclosedAt;
    found = [...blocks.found, ...patternMentions(lines, kind === 'compose' ? SUBSTITUTION : CI_REFERENCE)];
  }
  const trusted = found.filter(({ line }) => line <= unclosedAt); // a quote that never closes: the rest of the file is not trusted
  const kept = trusted.filter(({ name, keyed }) => isPlainName(name) || (keyed && name.length <= MAX_NAME_LENGTH));
  const mentions = kept.map(({ name, line }) => ({ name, line })).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return { mentions, hidden: found.length - kept.length };
}
