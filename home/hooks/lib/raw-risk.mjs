// Fail-to-ask rule: a command that uses ANY construct which can hide execution AND names a dangerous word anywhere in its raw
// text asks, whatever the quoting. It does not depend on either parser being right, so a lexer bug cannot turn into a silent bypass.
// Exports: riskyWordInExpansion(command, prodHosts) -> reason | undefined; RISKY_REASON.
// Hidden-execution constructs: `$(`, backtick, `<<` / `<<<` (except a plain top-level heredoc with a quoted delimiter read by cat or tee, whose
// body is data), `<(` / `>(`, `eval`, `trap`, `source` / `.`, `coproc`, `case`, a carriage return, a pipe into a shell, and the commands that
// run a text argument: watch, parallel, `PROMPT_COMMAND=`, `script|expect -c`, `perl|python|node|ruby|deno|bun -e|-c|-p`, `osascript -e`,
// `tmux new|send-keys`, `fish|pwsh -c`, `npx -c`, `npm exec -c`.
// Dangerous words (looked up as words of the quote-stripped, ANSI-C-decoded text): git push (by position) / git alias, rm with a recursive or forced flag and (also find -delete / -exec rm with)
// an absolute, `~`, `$` or `..` path, npm-style publish, gh mutations (judged by position: `gh <group> <verb>`), disk tools and raw device paths,
// psql/mysql/ssh near a production name. Message text of `git commit` and `gh pr|issue create|edit|comment` is data (message-text.mjs), so
// `git commit -m "$(cat <<'EOF' ... git push ... EOF)"` is silent; a message with another `$(` or a backtick is still scanned.
// A false positive costs a dialog. Commands with no hidden construct never reach this rule and keep the precise per-command checks.
// Pure, no I/O; linear in the text length.
import { ANSI_C_WORD, decodeAnsiC } from './ansi-c.mjs';
import { withoutMessageText } from './message-text.mjs';
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
const GH_VERBS = new Set(['merge', 'delete', 'archive', 'rename', 'transfer']);
const GH_READ_VERBS = new Set(['list', 'view', 'download']);
const GH_API_WORDS = new Set(['mutation', 'PUT', 'POST', 'PATCH', 'DELETE']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
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

const ASSIGNMENT_WORD = /^[A-Za-z_]\w*=/;
const STAGE_BREAK = /&&|\|\||[|;&]/;
const DATA_READERS = new Set(['cat', 'tee']);
const SKIPPED_BEFORE_READER = new Set(['sudo', 'command', 'builtin', 'nohup', 'time']);
const EXECUTING_STAGE = /^(?:sudo|env|xargs|source|\.|eval|exec|ssh|at|batch|crontab|expect|osascript|(?:ba|z|da|k|fi)?sh|python3?|node|perl|ruby|deno|bun)$/;
const XARGS_READER = /(?:^|[\s;&|(])xargs\b[^|;&]*$/;
const STDIN_FILE_READERS = /^git\b.*\bcommit\b.*(?:-F[ \t]*-|--file[= ][ \t]*-)|^gh\b.*(?:--body-file|-F)[= \t]+-(?:\s|$)/;

/**
 * True when the command reading a heredoc only stores or prints it: cat or tee (also behind sudo, an assignment, a path), `git commit -F -`,
 * `gh ... --body-file -`, and nothing later on the line pipes it into a shell or interpreter. Any other reader runs the body (`bash`,
 * `source`, `xargs`, `python3 -`, `ssh host`, `at`, `crontab -`, `expect`, `osascript`), so its body must be scanned.
 * @param {string} before the line up to the `<<`
 * @param {string} after the line after the heredoc delimiter
 */
function readsAsData(before, after) {
  const stage = before.split(STAGE_BREAK).pop().trim();
  const words = stage.split(/\s+/).filter((word) => !ASSIGNMENT_WORD.test(word) && !SKIPPED_BEFORE_READER.has(word));
  const reader = (words[0] ?? '').split('/').pop();
  if (!DATA_READERS.has(reader) && !STDIN_FILE_READERS.test(stage)) return false;
  return after.split('|').slice(1).every((piped) => !EXECUTING_STAGE.test((piped.trim().split(/\s+/)[0] ?? '').split('/').pop()));
}

/**
 * Text with the bodies of plain heredocs dropped: a line that opens one with a QUOTED delimiter (or an unquoted one whose body has no
 * expansion), outside any quote, backtick or parenthesis by a simple count, read by cat or tee, whose terminator line exists.
 * Anything unclear stays in, so it is scanned.
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
    const data = end !== -1 && readsAsData(before, line.slice(open.index + open[0].length)) && (open[5] === undefined || !EXPANSION_IN_BODY.test(lines.slice(i + 1, end).join('\n')));
    if (data) {
      kept.push(line.replace('<<', ' '));
      i = end;
      continue;
    }
    if (end !== -1 && XARGS_READER.test(before)) {
      kept.push(`${line} ${lines.slice(i + 1, end).join(' ')}`); // the body words become the command's arguments: `xargs rm -rf <<'EOF'`
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

const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;

/** True when a `find` deletes what it matches: `-delete`, or `-exec`/`-execdir`/`-ok` running rm (its `{}` path hides the target from the rm check). */
const findDeletes = (after) => after.includes('-delete') || after.some((w, i) => FIND_EXEC.test(w) && after[i + 1] === 'rm');

/** @returns {string | undefined} the category of the first dangerous word in this statement's words, or undefined */
function dangerIn(words, prodText, prodNames) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const after = words.slice(i + 1, i + 1 + WINDOW);
    if (word === 'git' && (pushesIn(after) || after.some((w) => w.startsWith('alias.')))) return 'git';
    if (word === 'rm' && after.some((w) => RM_FLAG.test(w)) && after.some((w) => RISKY_RM_PATH.test(w))) return 'destructive';
    if (word === 'find' && findDeletes(after) && after.some((w) => RISKY_RM_PATH.test(w))) return 'destructive';
    if (word === 'publish' && words.slice(Math.max(0, i - 3), i).some((w) => PUBLISHERS.has(w))) return 'publish';
    if (word === 'gh' && ghMutation(after)) return 'gh';
    if (word === 'dd' && after.some((w) => w.startsWith('of='))) return 'destructive';
    if (DISK_TOOLS.test(word) && (word !== 'diskutil' || after.some((w) => /^(?:erase|partition|zero|secureerase|reformat|apfs|delete)/i.test(w)))) return 'destructive';
    if (RAW_DEVICE.test(word)) return 'destructive';
    if (REMOTE_TOOLS.has(word) && (/prod/i.test(prodText) || prodNames.some((name) => prodText.includes(name)))) return 'remote';
  }
  return undefined;
}

/**
 * Whether `push` near `git` can publish. Loose on purpose (a heredoc or xargs may feed the words), with one narrow
 * exception: the plain form `git stash push ...` (stash right after git, then push, and no other push in the window),
 * which only stores local changes. Any global option before `stash` falls back to asking: option values can be shell
 * expansions that swallow words (`-${F:--namespace} stash push`, `-C ''`), so position after options is not trusted
 * (audit G1, R1).
 * @param {string[]} after - the words after `git` in one statement.
 * @returns {boolean} true when a `push` word may be a git push.
 */
function pushesIn(after) {
  const pushes = after.filter((w) => w === 'push').length;
  if (pushes === 0) return false;
  return !(after[0] === 'stash' && after[1] === 'push' && pushes === 1);
}

/** `gh <group> <verb>` by position (flags skipped): `gh pr create --title "delete x"` is not a delete; `gh release create` and `gh pr merge` are. */
function ghMutation(after) {
  const positional = [];
  for (let i = 0; i < after.length && positional.length < 2; i++) {
    if (GH_VALUE_FLAGS.has(after[i])) i++;
    else if (!after[i].startsWith('-')) positional.push(after[i]);
  }
  const [group, verb = ''] = positional;
  if (group === 'api') return after.some((w) => GH_API_WORDS.has(w) || w.startsWith('-X') || /^--method/.test(w));
  if (group === 'release') return !GH_READ_VERBS.has(verb);
  if (group === 'repo' && verb === 'edit') return true;
  if ((group === 'secret' || group === 'variable') && /^(?:set|delete|remove)$/.test(verb)) return true;
  return (group === 'workflow' && verb === 'run') || GH_VERBS.has(verb);
}

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'env', 'exec', 'command']);
const SCRIPT_INTERPRETERS = /^(?:perl|python3?|node|ruby|deno|bun|osascript|fish|pwsh|powershell|expect|script|npx)$/;
const SCRIPT_FLAG = /^-[a-zA-Z]*[ecp]$|^--(?:eval|print|command)$/i;
const TMUX_RUNNERS = new Set(['new', 'new-session', 'new-window', 'split-window', 'send-keys', 'send', 'run-shell', 'run', 'respawn-pane']);
const FLAG_WINDOW = 6;

/** True when a statement runs text it was given: watch/parallel, PROMPT_COMMAND=, an interpreter with -e/-c/-p, tmux new/send-keys, npm exec -c. */
function runsText(words) {
  return words.some((word, i) => {
    const next = words.slice(i + 1, i + 1 + FLAG_WINDOW);
    if (word.startsWith('PROMPT_COMMAND=')) return true;
    if ((word === 'watch' || word === 'parallel') && (i === 0 || WRAPPERS.has(words[i - 1]))) return true;
    if (SCRIPT_INTERPRETERS.test(word)) return next.some((w) => SCRIPT_FLAG.test(w));
    if (word === 'exec' && ['npm', 'pnpm', 'yarn'].includes(words[i - 1])) return next.some((w) => w === '-c' || w === '--call');
    return word === 'tmux' && next.some((w) => TMUX_RUNNERS.has(w));
  });
}

/**
 * @param {string} command raw command text
 * @param {string[]} prodHosts production host names from the private list (lowercase; `*` globs are matched by their literal part)
 * @returns {string | undefined} the ask reason (DESTRUCTIVE: first for rm, dd and disk tools), or undefined when no hidden construct meets a dangerous word
 */
export function riskyWordInExpansion(command, prodHosts = []) {
  // `$(git rev-parse --show-toplevel)` is a known, harmless substitution (the per-command rm check judges where it points)
  const text = joinContinuations(decodeAnsiCWords(command)).replace(GIT_TOPLEVEL, GIT_TOPLEVEL_WORD);
  const visible = withoutPlainHeredocs(withoutMessageText(text));
  const statements = visible.replace(/PROMPT_COMMAND=/g, 'PROMPT_COMMAND= ').replace(/[\\'"]/g, '').split(STATEMENT_BREAK).map(wordsOf);
  if (!HIDDEN_CONSTRUCT.test(visible) && !statements.some(runsText)) return undefined;
  const prodText = visible.toLowerCase();
  const prodNames = prodHosts.map((host) => host.replace(/[*?]/g, '')).filter(Boolean);
  const destructive = statements.map((words) => dangerIn(words, prodText, prodNames));
  const found = destructive.find((category) => category !== undefined);
  if (found === undefined) return undefined;
  return destructive.includes('destructive') ? `${DESTRUCTIVE_PREFIX}${RISKY_REASON}` : RISKY_REASON;
}
