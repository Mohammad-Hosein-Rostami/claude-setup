// Fail-to-ask rule: a command that uses ANY construct which can hide execution AND names a dangerous word anywhere in its raw
// text asks, whatever the quoting. It does not depend on either parser being right, so a lexer bug cannot turn into a silent bypass.
// Exports: riskyWordInExpansion(command, prodHosts) -> reason | undefined; RISKY_REASON.
// Hidden-execution constructs: `$(`, backtick, `<<` / `<<<` (except a plain top-level heredoc with a quoted delimiter, whose body is data),
// `<(` / `>(`, `eval`, `trap`, `source` / `.`, `coproc`, `case`, a carriage return, and a pipe into a shell.
// Dangerous words (looked up as words of the quote-stripped, ANSI-C-decoded text): git push / git alias, rm with a recursive or forced flag and
// an absolute, `~`, `$` or `..` path, npm-style publish, gh mutations, disk tools and raw device paths, psql/mysql/ssh near a production name.
// A false positive costs a dialog, so it is accepted: `git commit -m "$(cat <<'EOF' ... git push ... EOF)"` asks. Commands with no such
// construct never reach this rule and keep the precise per-command checks. Pure, no I/O; linear in the text length.
import { ANSI_C_WORD, decodeAnsiC } from './ansi-c.mjs';
import { GIT_TOPLEVEL, GIT_TOPLEVEL_WORD } from './shell-words.mjs';
import { DESTRUCTIVE_PREFIX } from './verdict.mjs';

export const RISKY_REASON = 'risky word inside shell expansion';
const HIDDEN_CONSTRUCT = /\$\(|`|<<|<\(|>\(|\r|\b(?:eval|trap|source|coproc|case)\b|(?:^|[;&|(\n])[ \t]*\.[ \t]+\S|\|[ \t]*(?:sudo[ \t]+)?(?:ba|z|da|k)?sh\b/;
const ANSI_C = new RegExp(ANSI_C_WORD, 'g');
const STATEMENT_BREAK = /[;&|\n\r]+/;
const WORD_BREAK = /[\s<>`]+|\$\(|\(/;
const WORD_EDGE = /^[$({`]+|[)}`]+$/g; // `$(rm` -> `rm`, `/)` -> `/`; a `$(cmd)/dir` word stays unrecognisable on purpose
const WINDOW = 12; // words after a verb that still count as its arguments
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'lerna', 'changeset', 'npx']);
const GH_MUTATIONS = new Set(['release', 'merge', 'delete', 'archive', 'rename', 'transfer', 'edit', 'mutation', 'PUT', 'POST', 'PATCH', 'DELETE']);
const DISK_TOOLS = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?|wipefs|blkdiscard|shred|diskutil)$/;
const RAW_DEVICE = /^\/dev\/(?:r?disk|sd[a-z]|hd[a-z]|nvme|vd[a-z]|xvd|mmcblk)/;
const REMOTE_TOOLS = new Set(['psql', 'mysql', 'mariadb', 'mysqldump', 'pg_dump', 'pg_restore', 'ssh', 'scp', 'rsync']);
const RM_FLAG = /^(?:-[a-zA-Z]*[rRf]|--recursive|--force)/;
// a literal root-relative path, `~`, `..` or the home variable; other variable paths are the precise checks' job
const RISKY_RM_PATH = /^(?:\/|~|\.\.(?:\/|$)|\$\{?HOME\b)/;
const HEREDOC_OPEN = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))(?![\w'"\\])/;
const EXPANSION_IN_BODY = /\$\(|`/;

const wordsOf = (statement) => statement.split(WORD_BREAK).map((word) => word.replace(WORD_EDGE, '')).filter(Boolean);
const decodeAnsiCWords = (text) => text.replace(ANSI_C, (word) => decodeAnsiC(word.slice(2, -1)));
const joinContinuations = (text) => text.replace(/\\\r?\n/g, '');

/**
 * Text with the bodies of plain heredocs dropped: a line that opens one with a QUOTED delimiter, outside any quote, backtick or
 * parenthesis by a simple count, whose terminator line exists. Anything unclear stays in, so it is scanned.
 */
function withoutPlainHeredocs(text) {
  const lines = text.split('\n');
  const kept = [];
  let quotes = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = HEREDOC_OPEN.exec(line);
    const before = open ? line.slice(0, open.index) : '';
    const plain = open && (quotes + count(before, /(?<!\\)["'`]/g)) % 2 === 0 && depth + count(before, /[(]/g) - count(before, /[)]/g) <= 0 && !/\$\(|`/.test(line.slice(open.index));
    const delimiter = open && (open[2] ?? open[3] ?? open[4] ?? open[5]);
    const end = plain ? lines.findIndex((l, at) => at > i && (open[1] ? l.replace(/^\t+/, '') : l) === delimiter) : -1;
    // a quoted delimiter makes the body data; an unquoted one only when the body has no expansion that could run
    const data = end !== -1 && (open[5] === undefined || !EXPANSION_IN_BODY.test(lines.slice(i + 1, end).join('\n')));
    if (data) {
      kept.push(line.replace('<<', ' '));
      i = end;
      continue;
    }
    quotes += count(line, /(?<!\\)["'`]/g);
    depth += count(line, /[(]/g) - count(line, /[)]/g);
    kept.push(line);
  }
  return kept.join('\n');
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** @returns {string | undefined} the category of the first dangerous word in this statement's words, or undefined */
function dangerIn(words, prodText, prodNames) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const after = words.slice(i + 1, i + 1 + WINDOW);
    if (word === 'git' && after.some((w) => w === 'push' || w.startsWith('alias.'))) return 'git';
    if (word === 'rm' && after.some((w) => RM_FLAG.test(w)) && after.some((w) => RISKY_RM_PATH.test(w))) return 'destructive';
    if (word === 'publish' && words.slice(Math.max(0, i - 3), i).some((w) => PUBLISHERS.has(w))) return 'publish';
    if (word === 'gh' && ghMutation(after)) return 'gh';
    if (word === 'dd' && after.some((w) => w.startsWith('of='))) return 'destructive';
    if (DISK_TOOLS.test(word) && (word !== 'diskutil' || after.some((w) => /^(?:erase|partition|zero|secureerase|reformat|apfs|delete)/i.test(w)))) return 'destructive';
    if (RAW_DEVICE.test(word)) return 'destructive';
    if (REMOTE_TOOLS.has(word) && (/prod/i.test(prodText) || prodNames.some((name) => prodText.includes(name)))) return 'remote';
  }
  return undefined;
}

function ghMutation(after) {
  return after.some((w, i) => GH_MUTATIONS.has(w) || w.startsWith('-X') || /^--method/.test(w)
    || ((w === 'secret' || w === 'variable') && /^(?:set|delete|remove)$/.test(after[i + 1] ?? ''))
    || (w === 'workflow' && after[i + 1] === 'run'));
}

/**
 * @param {string} command raw command text
 * @param {string[]} prodHosts production host names from the private list (lowercase; `*` globs are matched by their literal part)
 * @returns {string | undefined} the ask reason (DESTRUCTIVE: first for rm, dd and disk tools), or undefined when no hidden construct meets a dangerous word
 */
export function riskyWordInExpansion(command, prodHosts = []) {
  // `$(git rev-parse --show-toplevel)` is a known, harmless substitution (the per-command rm check judges where it points)
  const text = joinContinuations(decodeAnsiCWords(command)).replace(GIT_TOPLEVEL, GIT_TOPLEVEL_WORD);
  const visible = withoutPlainHeredocs(text);
  if (!HIDDEN_CONSTRUCT.test(visible)) return undefined;
  const prodText = visible.toLowerCase();
  const prodNames = prodHosts.map((host) => host.replace(/[*?]/g, '')).filter(Boolean);
  const destructive = visible.replace(/[\\'"]/g, '').split(STATEMENT_BREAK).map((statement) => dangerIn(wordsOf(statement), prodText, prodNames));
  const found = destructive.find((category) => category !== undefined);
  if (found === undefined) return undefined;
  return destructive.includes('destructive') ? `${DESTRUCTIVE_PREFIX}${RISKY_REASON}` : RISKY_REASON;
}
