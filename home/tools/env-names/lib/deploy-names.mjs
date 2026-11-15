// Finds the environment variable names a deploy file mentions: Dockerfile ARG/ENV, compose `environment:` and `${NAME}`,
// GitHub workflow and GitLab CI `env:` keys with `secrets.NAME` / `vars.NAME`.
// Exports: scanDeploy(kind, text) -> [{ name, line }] sorted by line then name; deployKind(path) -> kind or null.
// Invariants: pure; only the name part of an assignment is captured, the value (even a quoted one holding `X=y`) is skipped
//   unread. Kinds: dockerfile, compose, workflow, gitlab.
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const NAME_AT_START = new RegExp(`^${NAME}`);
const SUBSTITUTION = new RegExp(`\\$\\{(${NAME})`, 'g');
const CI_REFERENCE = new RegExp(`\\b(?:secrets|vars)\\.(${NAME})`, 'g');
const MAP_ENTRY = new RegExp(`^(${NAME})\\s*:(?:\\s|$)`);
const LIST_ENTRY = new RegExp(`^-\\s+['"]?(${NAME})(?:=|['"]|\\s|$)`);
const BLOCK_OPENER = /^(\s*)([A-Za-z_-]+):\s*(?:#.*)?$/;
const INSTRUCTION = /^\s*(?:ARG|ENV)\s+(.*)$/i;
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
    names.push(name);
    if (next !== '=') break; // `ENV NAME value`: the rest of the line is the value
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
    while (joined.trimEnd().endsWith('\\') && i + 1 < lines.length) joined = `${joined.trimEnd().slice(0, -1)} ${lines[(i += 1)]}`;
    const args = INSTRUCTION.exec(joined)?.[1];
    if (args !== undefined && !joined.trimStart().startsWith('#')) assignmentNames(args).forEach((name) => found.push({ name, line: startLine }));
  }
  return found;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === '' || line.trimStart().startsWith('#');

/** Entries of the block under `keys: ` lines: only lines at the block's own indent count, deeper lines (block scalars) do not. */
function blockEntries(lines, keys) {
  const found = [];
  lines.forEach((line, index) => {
    const opener = BLOCK_OPENER.exec(line);
    if (opener === null || !keys.includes(opener[2])) return;
    let blockIndent = null;
    for (let i = index + 1; i < lines.length; i += 1) {
      if (isSkippable(lines[i])) continue;
      const indent = indentOf(lines[i]);
      if (indent <= indentOf(line) || (blockIndent !== null && indent < blockIndent)) break;
      blockIndent ??= indent;
      if (indent !== blockIndent) continue;
      const text = lines[i].trim();
      const name = (MAP_ENTRY.exec(text) ?? LIST_ENTRY.exec(text))?.[1];
      if (name !== undefined) found.push({ name, line: i + 1 });
    }
  });
  return found;
}

/** Every match of `pattern` (first capture group is the name) on lines that are not comments. */
function patternMentions(lines, pattern) {
  const found = [];
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return;
    for (const match of line.matchAll(pattern)) found.push({ name: match[1], line: index + 1 });
  });
  return found;
}

/**
 * @param {'dockerfile'|'compose'|'workflow'|'gitlab'} kind
 * @param {string} text file content
 * @returns {{ name: string, line: number }[]} sorted by line, then name
 */
export function scanDeploy(kind, text) {
  const lines = text.split(/\r\n|\r|\n/);
  let found;
  if (kind === 'dockerfile') found = scanDockerfile(lines);
  else if (kind === 'compose') found = [...blockEntries(lines, BLOCK_KEYS.compose), ...patternMentions(lines, SUBSTITUTION)];
  else found = [...blockEntries(lines, BLOCK_KEYS[kind]), ...patternMentions(lines, CI_REFERENCE)];
  return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}
