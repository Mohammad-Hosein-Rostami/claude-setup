// Finds the environment variable names a deploy file mentions: Dockerfile ARG/ENV, compose `environment:` and `${NAME}`,
// GitHub workflow and GitLab CI `env:` keys with `secrets.NAME` / `vars.NAME`.
// Exports: scanDeploy(kind, text) -> { mentions, unconfirmed: [{ name, line }], hidden }; deployKind(path) -> kind or null.
// Invariants: pure; only the name part of an assignment is captured, the value (even a quoted one holding `X=y`) is skipped
//   unread. Kinds: dockerfile, compose, workflow, gitlab. Output rule: a name is kept when it is a plain name (see
//   name-shape.mjs), or when it sits in a KEY position (`NAME:` of a YAML mapping, `${NAME`, `${{ secrets.NAME }}`) and has
//   at most 64 characters; never one taken from the left of `=` in a Dockerfile or a `- NAME=value` item unless plain.
//   Anything else is counted in `hidden`. Skipped as value text: Dockerfile heredoc bodies.
//   A YAML block under `environment:`, `env:` or `variables:` is trusted only when every line is on a whitelist (see scanBlock);
//   a block with any other line (anchor, alias, tag, block scalar, flow map, a quote that does not close on its line, a key with a
//   space, a deeper line, a tab) gives only `unconfirmed` names, as does every line after a quote or flow map left open.
import { MAX_NAME_LENGTH, isPlainName } from './name-shape.mjs';

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const NAME_AT_START = new RegExp(`^${NAME}`);
// `$${NAME}` is compose's escape for a literal `${NAME}`: not a substitution.
const SUBSTITUTION = new RegExp(`(?<!\\$)\\$\\{(${NAME})`, 'g');
// Only inside a `${{ ... }}` expression: the words secrets.X in a plain string are text, not a reference.
const CI_REFERENCE = new RegExp(`(?<=\\$\\{\\{[^}]*)\\b(?:secrets|vars)\\.(${NAME})`, 'g');
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

// The whitelist for one line of a block. A key is a name, or a name in one pair of matching quotes.
const MAP_LINE = new RegExp(`^(?:"(${NAME})"|'(${NAME})'|(${NAME}))\\s*:(?:\\s+(.*))?$`);
const ITEM_LINE = /^-\s+(.+)$/;
const ITEM_NAME = new RegExp(`^(${NAME})(?=$|=|["'\\s])`);
const CLEAN_ITEM = new RegExp(`^${NAME}(?:=.*)?$`);
const SPECIAL_VALUE_START = /^[&*!|>{[\]},%@`"'?]/; // anchor, alias, tag, block scalar, flow, quote, directive, reserved
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\[^"])*)"\s*(?:#.*)?$/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'\s*(?:#.*)?$/;
const CLOSED_QUOTE_START = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/;

/** The text inside a value that is quoted completely on one line (no backslash right before the closing quote), else null. */
function quotedBody(value) {
  const body = (DOUBLE_QUOTED.exec(value) ?? SINGLE_QUOTED.exec(value))?.[1];
  return body === undefined || body.endsWith('\\') ? null : body;
}

/** True when a value starts a quote or a flow map or list that does not end on its own line. */
function opensWithoutClosing(value) {
  if (value[0] === '"' || value[0] === "'") return !CLOSED_QUOTE_START.test(value);
  if (value[0] !== '{' && value[0] !== '[') return false;
  const opening = value.split(/[{[]/).length;
  return opening > value.split(/[}\]]/).length;
}

/** A map value the whitelist accepts: empty, a comment, plain text that starts with no special character, or fully quoted on the line. */
function isCleanMapValue(value) {
  return value === '' || (!SPECIAL_VALUE_START.test(value) && !value.includes('\t')) || quotedBody(value) !== null;
}

/**
 * Reads one trimmed block line. `name` is the name the line starts with (or undefined), `clean` says the whole line is on the
 * whitelist: `NAME:` with an empty, plain or one-line quoted value, `- NAME`, `- NAME=value`, or the item fully quoted on the line.
 * `open` is true when the line starts a quote or flow collection that does not end on it.
 */
function readBlockLine(text) {
  const map = MAP_LINE.exec(text);
  if (map !== null) {
    const value = (map[4] ?? '').trim();
    return { name: map[1] ?? map[2] ?? map[3], keyed: true, clean: isCleanMapValue(value), open: opensWithoutClosing(value) };
  }
  const rest = ITEM_LINE.exec(text)?.[1].trim();
  if (rest === undefined) return { name: undefined, keyed: false, clean: false, open: false };
  const quoted = rest[0] === '"' || rest[0] === "'";
  const body = quoted ? quotedBody(rest) : rest;
  return {
    name: ITEM_NAME.exec(quoted ? rest.slice(1) : rest)?.[1],
    keyed: false,
    clean: body !== null && CLEAN_ITEM.test(body),
    open: opensWithoutClosing(rest),
  };
}

/**
 * The lines under one `environment:`-style line, checked against the whitelist (see readBlockLine). The block is REGULAR only
 * when every line is blank, a comment or a clean entry at one indent, with no tab: anything else (anchor, alias, tag, block
 * scalar, flow map or list, a quote that does not close on its line, a key with a space, a deeper or shifted line) makes it
 * irregular, and then no name of it is trusted. `entries` are the names the lines start with, `lastLine` is the last line of the
 * block (1-based), `openAt` the first line that starts a quote or flow collection that does not end on it (Infinity when none).
 */
function scanBlock(lines, from, openerIndent) {
  const block = { entries: [], regular: true, lastLine: from, openAt: Infinity };
  let blockIndent = null;
  for (let i = from; i < lines.length && (isSkippable(lines[i]) || indentOf(lines[i]) > openerIndent); i += 1) {
    if (isSkippable(lines[i])) continue;
    block.lastLine = i + 1;
    blockIndent ??= indentOf(lines[i]);
    const read = readBlockLine(lines[i].trim());
    if (read.name !== undefined) block.entries.push({ name: read.name, line: i + 1, keyed: read.keyed });
    if (read.open) block.openAt = Math.min(block.openAt, i + 1);
    if (!read.clean || indentOf(lines[i]) !== blockIndent || lines[i].includes('\t')) block.regular = false;
  }
  return block;
}

/**
 * Names under the `keys: ` lines of a deploy file, each with `doubt: true` when it comes from an irregular block (so it prints
 * only if code reads it too). `doubtful(line)` says whether any name found on that line is in doubt: the line is inside an
 * irregular block, or after a quote or flow collection that was left open (the lines after it may be value text).
 */
function blockEntries(lines, keys) {
  const found = [];
  const irregularLines = [];
  let openAt = Infinity;
  lines.forEach((line, index) => {
    const opener = BLOCK_OPENER.exec(line);
    if (opener === null || !keys.includes(opener[2])) return;
    const block = scanBlock(lines, index + 1, indentOf(line));
    openAt = Math.min(openAt, block.openAt);
    if (!block.regular) irregularLines.push([index + 2, block.lastLine]);
    found.push(...block.entries.map((entry) => ({ ...entry, doubt: !block.regular })));
  });
  const doubtful = (lineNumber) => lineNumber >= openAt || irregularLines.some(([first, last]) => lineNumber >= first && lineNumber <= last);
  return { found, doubtful };
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
 * @returns {{ mentions: { name: string, line: number }[], unconfirmed: { name: string, line: number }[], hidden: number }}
 *   `mentions`: names to print, sorted by line then name. `unconfirmed`: names from a block with an unusual layout (anything
 *   that may hold value text): the caller prints one only when code reads the same name. `hidden`: names left out by the name shape.
 */
export function scanDeploy(kind, text) {
  const lines = text.split(/\r\n|\r|\n/);
  let found;
  let doubtful = () => false;
  if (kind === 'dockerfile') {
    found = scanDockerfile(lines);
  } else {
    const blocks = blockEntries(lines, BLOCK_KEYS[kind]);
    doubtful = blocks.doubtful;
    found = [...blocks.found, ...patternMentions(lines, kind === 'compose' ? SUBSTITUTION : CI_REFERENCE)];
  }
  const kept = found.filter(({ name, keyed }) => isPlainName(name) || (keyed && name.length <= MAX_NAME_LENGTH));
  const toMention = ({ name, line }) => ({ name, line });
  const bySourceOrder = (a, b) => a.line - b.line || a.name.localeCompare(b.name);
  const inDoubt = ({ doubt, line }) => doubt === true || doubtful(line);
  return {
    mentions: kept.filter((entry) => !inDoubt(entry)).map(toMention).sort(bySourceOrder),
    unconfirmed: kept.filter(inDoubt).map(toMention).sort(bySourceOrder),
    hidden: found.length - kept.length,
  };
}
