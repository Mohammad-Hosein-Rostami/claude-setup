// Finds the environment variable names a deploy file mentions: Dockerfile ARG/ENV, compose `environment:` and `${NAME}`,
// GitHub workflow and GitLab CI `env:` / `variables:` keys with `secrets.NAME` / `vars.NAME`.
// Exports: scanDeploy(kind, text) -> { mentions, unconfirmed: [{ name, line }], hidden, untrusted, parserMissing };
//   deployKind(path) -> kind or null.
// Invariants: pure; only the name part of an assignment is captured, the value (even a quoted one holding `X=y`) is skipped
//   unread. Kinds: dockerfile, compose, workflow, gitlab. Dockerfiles are read line by line (heredoc bodies skipped); YAML kinds
//   are read by a real parser (deploy-yaml-names.mjs): names come only from parsed map keys, and a file the parser reports any
//   error or warning for gives only `unconfirmed` names. Output rule: a name is kept when it is a plain name (see name-shape.mjs),
//   or when it is a map key, `${NAME`, or `${{ secrets.NAME }}` and has at most 64 characters; never one taken from the left of
//   `=` in a Dockerfile or a `- NAME=value` item unless plain. Anything else is counted in `hidden`.
import { MAX_NAME_LENGTH, isPlainName } from './name-shape.mjs';
import { scanYamlDeploy, yamlParserInstalled } from './deploy-yaml-names.mjs';

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const NAME_AT_START = new RegExp(`^${NAME}`);
const INSTRUCTION = /^\s*(?:ARG|ENV)\s+(.*)$/i;
const HEREDOC_TAG = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g;

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

const toMention = ({ name, line }) => ({ name, line });
const bySourceOrder = (a, b) => a.line - b.line || a.name.localeCompare(b.name);
const isShownShape = ({ name, keyed }) => isPlainName(name) || (keyed && name.length <= MAX_NAME_LENGTH);

/**
 * @param {'dockerfile'|'compose'|'workflow'|'gitlab'} kind
 * @param {string} text file content
 * @param {boolean} parserInstalled whether the YAML parser is there; only tests pass it (to simulate a missing parser)
 * @returns {{ mentions: { name: string, line: number }[], unconfirmed: { name: string, line: number }[], hidden: number,
 *   untrusted: boolean, parserMissing: boolean }}
 *   `mentions`: names to print, sorted by line then name. `unconfirmed`: names from a YAML file the parser reported a problem
 *   with: the caller prints one only when code reads the same name. `hidden`: names left out by the name shape.
 *   `untrusted`: the YAML file had a problem (set even when no name was found). `parserMissing`: a YAML file was not read
 *   because the `yaml` package is not installed.
 */
export function scanDeploy(kind, text, parserInstalled = yamlParserInstalled) {
  const result = { mentions: [], unconfirmed: [], hidden: 0, untrusted: false, parserMissing: false };
  if (kind !== 'dockerfile' && !parserInstalled) return { ...result, parserMissing: true };
  const scanned = kind === 'dockerfile' ? { found: scanDockerfile(text.split(/\r\n|\r|\n/)), notNames: 0, untrusted: false } : scanYamlDeploy(kind, text);
  const kept = scanned.found.filter(isShownShape).map(toMention).sort(bySourceOrder);
  return {
    ...result,
    mentions: scanned.untrusted ? [] : kept,
    unconfirmed: scanned.untrusted ? kept : [],
    hidden: scanned.found.length - kept.length + scanned.notNames,
    untrusted: scanned.untrusted,
  };
}
