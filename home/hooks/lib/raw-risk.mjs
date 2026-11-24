// Fail-to-ask rule: a command that uses ANY construct which can hide execution AND names a dangerous word anywhere in its raw
// text asks, whatever the quoting. It does not depend on either primary parser being right, so a lexer bug cannot turn into a silent bypass.
// One exemption reads quotes itself (lib/inert-arguments.mjs, data arguments); it only empties a word in shapes it can prove harmless and gives
// the text back unchanged (so the rule asks) for anything it cannot read the way the shell does.
// Exports: riskyWordInExpansion(command, prodHosts) -> reason | undefined; RISKY_REASON; unreadableNameReasons(cmd, command, prodHosts)
// -> string[] and UNREADABLE_NAME_REASON (a command word outside ASCII next to a dangerous word: a look-alike name hides what runs).
// Hidden-execution constructs: `$(`, backtick, `<<` / `<<<` (except a plain top-level heredoc with a quoted delimiter read by cat or tee, whose
// body is data), `<(` / `>(`, `eval`, `trap`, `source` / `.`, `coproc`, `case`, a carriage return, a pipe into a shell, and the commands that
// run a text argument: watch, parallel, `PROMPT_COMMAND=`, `script|expect -c`, `perl|python|node|ruby|deno|bun -e|-c|-p`, `php -r`, `deno eval`, `osascript -e`,
// `tmux new|send-keys`, `fish|pwsh -c`, `npx -c`, `npm exec -c`. Git constructs, whose commands lib/git-runs.mjs cannot read: config read
// from a file (`GIT_CONFIG_GLOBAL|SYSTEM=` other than /dev/null, `include.path`, `includeIf.<condition>.path`), and in a line that runs
// git, a variable or config key whose value git runs (git-runs COMMAND_ENV, configKind) next to a `$`, backtick, `+=`, `declare`, `read`
// or `printf -v`. Git may run any variable's value, so with a git construct the words of assignment values count too; when only git
// hides what runs, the reason is GIT_UNREADABLE_REASON (an ask: no rewrite helps); so is a git-run variable set from an unquoted backtick,
// whose value both parsers lose (lib/git-run-values.mjs reads the other forms). `git-<sub>` words read as `git <sub>` (lib/command-of.mjs).
// Dangerous words (looked up as words of the quote-stripped, ANSI-C-decoded text): git push (by position) / git alias, rm with a recursive or forced flag and (also find -delete / -exec rm with)
// an absolute, `~`, `$` or `..` path (once the line has a `cd`, `pushd` or `popd`, any path of a recursive rm or a deleting find: the
// hidden text may run in another folder, X3), npm-style publish, gh mutations (judged by position: `gh <group> <verb>`), disk tools and raw device paths,
// psql/mysql/ssh near a production name. An unquoted `rm` right after docker|podman|nerdctl (or their container|image|volume|network), kubectl, git,
// npm, pnpm, yarn, brew, cargo, go, pip or gh as the statement's command word is its sub-command, and an unquoted redirect's target is no rm path. Message text of `git commit` and `gh pr|issue create|edit|comment` is data (message-text.mjs), so
// `git commit -m "$(cat <<'EOF' ... git push ... EOF)"` is silent; a message with another `$(` or a backtick is still scanned.
// A single-quoted argument of a program that never runs its arguments (echo, printf, grep, rg, jq, sed, git log) is data too (lib/inert-arguments.mjs).
// A false positive costs a dialog. Commands with no hidden construct never reach this rule and keep the precise per-command checks.
// Pure, no I/O; linear in the text length.
import { ANSI_C_WORD, decodeAnsiC } from './ansi-c.mjs';
import { quotedChars } from './braces.mjs';
import { asGitSubcommand, commandName } from './command-of.mjs';
import { withoutInertArguments } from './inert-arguments.mjs';
import { withoutMessageText } from './message-text.mjs';
import { WINDOW, deletesInMovedText, findDeletes } from './moved-text.mjs';
import { GIT_TOPLEVEL, GIT_TOPLEVEL_WORD, MKTEMP_WORD } from './shell-words.mjs';
import { COMMAND_ENV, configKind, GIT_UNREADABLE_REASON } from './git-runs.mjs';
import { DESTRUCTIVE_PREFIX } from './verdict.mjs';

export const RISKY_REASON = 'risky word inside shell expansion';
const HIDDEN_CONSTRUCT = /\$\(|`|<<|<\(|>\(|\r|\b(?:eval|trap|source|coproc|case)\b|(?:^|[;&|(\n])[ \t]*\.[ \t]+\S|\|[ \t]*(?:sudo[ \t]+)?(?:ba|z|da|k)?sh\b/;
// `git help config`: these make git read config, which may run commands, from a file; /dev/null is empty. Config names match in any case.
const GIT_FILE_CONFIG = /\bGIT_CONFIG_(?:GLOBAL|SYSTEM)=(?!["']?\/dev\/null["']?(?:[\s;&|)]|$))|include(?:if\.[^\s=]*)?\.path\b/i;
const GIT_COMMAND_WORD = /(?:^|[\s;&|(`/\\])git(?:-[A-Za-z0-9][A-Za-z0-9-]*)?(?=[\s;&|)`]|$)/;
// a variable git runs, not read as `$NAME` / `${NAME}`
const GIT_RUN_VARIABLE = new RegExp(`(?<![\\w$]|\\$\\{)(?:${[...COMMAND_ENV, 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_(?:KEY|VALUE)_\\d+'].join('|')})\\b`);
const BACKTICK_RUN_VALUE = new RegExp(`(?<![\\w$]|\\$\\{)(?:${COMMAND_ENV.join('|')})\\+?=[^\\s;&|<>()]*\``);
const UNREAD_VALUE = /[$`]|\+=|\b(?:declare|typeset|local|readonly|read|mapfile|readarray)\b|\bprintf\s+-v\b/;
const KEY_BREAK = /[\s="'`$;&|()<>]+/;
const RUN_VALUE_ASSIGNMENT = /PROMPT_COMMAND=/g; // the shell runs this variable's value
const ANY_ASSIGNMENT = /(?:^|[\s;&|(])[A-Za-z_]\w*\+?=/g;
const ANSI_C = new RegExp(ANSI_C_WORD, 'g');
const STATEMENT_BREAK = /[;&|\n\r]+/;
const WORD_BREAK = /[\s<>`]+|\$\(|\(/;
const WORD_EDGE = /^[$({`]+|[)}`]+$/g; // `$(rm` -> `rm`, `/)` -> `/`; a `$(cmd)/dir` word stays unrecognisable on purpose
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'lerna', 'changeset', 'npx']);
const GH_VERBS = new Set(['merge', 'delete', 'archive', 'rename', 'transfer']);
const GH_READ_VERBS = new Set(['list', 'view', 'download']);
const GH_API_WORDS = new Set(['mutation', 'PUT', 'POST', 'PATCH', 'DELETE']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
const DISK_TOOLS = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?|wipefs|blkdiscard|shred|diskutil)$/;
const RAW_DEVICE = /^\/dev\/(?:r?disk|sd[a-z]|hd[a-z]|nvme|vd[a-z]|xvd|mmcblk)/;
const REMOTE_TOOLS = new Set(['psql', 'mysql', 'mariadb', 'mysqldump', 'pg_dump', 'pg_restore', 'ssh', 'scp', 'rsync']);
const RM_FLAG = /^(?:-[a-zA-Z]*[rRf]|--r|--f|--n)/; // GNU rm takes a prefix of a long option: `--rec`, `--fo`, `--no-pre`
// a literal root-relative path, `~`, `..` or the home variable; other variable paths are the precise checks' job
const RISKY_RM_PATH = /^(?:\/|~|\.\.(?:\/|$)|\$\{?HOME\b)/;
const HEREDOC_OPEN = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))(?![\w'"\\])/;
const EXPANSION_IN_BODY = /\$\(|`/;
// X10 (spec F2): `rm` is a tool's sub-command only as the word right after the tool, when the tool is the statement's command word (after
// only keywords and plain assignments; not after `)` or `}`, as `exec -a $(true) go rm` runs rm): `sudo -g docker rm`, `A="x git" rm` keep rm.
const RM_SUBCOMMAND = new RegExp(String.raw`((?:^|[;&|(\n\r]|\{[ \t])[ \t]*(?:(?:if|then|elif|else|do|while|until|!)[ \t]+)*`
  + String.raw`(?:[A-Za-z_]\w*=[^\s'"\\$\x60;&|()<>]*[ \t]+)*(?:(?:docker|podman|nerdctl)(?:[ \t]+(?:container|image|volume|network))?|`
  + String.raw`kubectl|git|npm|pnpm|yarn|brew|cargo|go|pip|gh)[ \t]+)rm(?=[\s;&|)]|$)`, 'g');
const SUBCOMMAND_RM = 'rm:sub-command'; // a word no rule reads as the rm program
// X10: the target of a redirect (`>x`, `>>x`, `2>x`, `&>x`, `<x`; not `<<`, `<<<`, `<(`, `>(`) is a file the shell opens, never an rm path.
// It keeps REDIRECT_MARK in front (NUL, which bash drops from its input, so the text cannot hold one of its own): only the rm and find
// path tests read the mark; every other rule reads the target as before (`> /dev/disk2` is still a raw device).
const REDIRECT = /(?<![<>&\d])(?:\d+|&)?(?:>>?|<)(?![(<>])[ \t]*(&\d+|&-|[^\s;&|<>()`]+)/g;
const REDIRECT_MARK = '\u0000';
const NUL = /\u0000/g;
const unmarked = (word) => (word.startsWith(REDIRECT_MARK) ? word.slice(REDIRECT_MARK.length) : word);

/**
 * The X10 marks (SUBCOMMAND_RM, REDIRECT_MARK), only where the whole match is unquoted and unescaped: `rm ">" ~/x`, `rm \> ~/x`, text in
 * `watch '...'` and every line with a `$'...'` word (decoded without its quotes, so `readsQuotes` is false) keep their rm paths.
 */
function marked(text, readsQuotes) {
  if (!readsQuotes) return text;
  const free = (quoted, at, length) => !quoted.subarray(at, at + length).includes(1);
  let quoted = quotedChars(text);
  const withSubcommands = text.replace(RM_SUBCOMMAND, (whole, start, at) => (free(quoted, at, whole.length) ? `${start}${SUBCOMMAND_RM}` : whole));
  quoted = quotedChars(withSubcommands);
  return withSubcommands.replace(REDIRECT, (whole, target, at) => {
    if (!free(quoted, at, whole.length - target.length)) return whole;
    return target.startsWith('&') ? ' ' : ` ${REDIRECT_MARK}${target}`;
  });
}

/** `git-<sub>` (any directory) -> `git`, `<sub>`: git's own program is the git command it runs; other words stay as they are. */
function gitProgramWords(word) {
  const command = asGitSubcommand({ cmd: commandName(word), args: [] });
  return command.args.length > 0 ? [command.cmd, ...command.args] : [word];
}
const wordsOf = (statement) => statement.split(WORD_BREAK).map((word) => word.replace(WORD_EDGE, '')).filter(Boolean).flatMap(gitProgramWords);
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

// `$(mktemp -d)` only makes a new empty folder: like the git top-level, it hides no command (the rm rules judge where it points)
const PLAIN_MKTEMP = /\$\(mktemp -d\)/g;

/** @returns {string | undefined} the category of the first dangerous word in this statement's words (redirect targets marked), or undefined */
function dangerIn(marked, prodText, prodNames) {
  const words = marked.map(unmarked);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]; // exact case: this scan cannot tell a command word from quoted prose (`Git push` in a message)
    const after = words.slice(i + 1, i + 1 + WINDOW);
    const riskyPath = marked.slice(i + 1, i + 1 + WINDOW).some((w) => RISKY_RM_PATH.test(w)); // a marked redirect target never matches
    if (word === 'git' && (pushesIn(after) || after.some((w) => w.startsWith('alias.')))) return 'git';
    if (word === 'rm' && after.some((w) => RM_FLAG.test(w)) && riskyPath) return 'destructive';
    if (word === 'find' && findDeletes(after) && riskyPath) return 'destructive';
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
const SCRIPT_INTERPRETERS = /^(?:perl|python[\d.]*|php|node|ruby|deno|bun|osascript|fish|pwsh|powershell|expect|script|npx)$/;
const SCRIPT_FLAG = /^-[a-zA-Z]*[ecpr]$|^--(?:eval|print|command)$/i;
const TMUX_RUNNERS = new Set(['new', 'new-session', 'new-window', 'split-window', 'send-keys', 'send', 'run-shell', 'run', 'respawn-pane']);
const FLAG_WINDOW = 6;

/** True when a statement runs text it was given: watch/parallel, PROMPT_COMMAND=, an interpreter with -e/-c/-p, tmux new/send-keys, npm exec -c. */
function runsText(words) {
  return words.some((word, i) => {
    const next = words.slice(i + 1, i + 1 + FLAG_WINDOW);
    if (word.startsWith('PROMPT_COMMAND=')) return true;
    if ((word === 'watch' || word === 'parallel') && (i === 0 || WRAPPERS.has(words[i - 1]))) return true;
    if (SCRIPT_INTERPRETERS.test(word)) return next.some((w) => SCRIPT_FLAG.test(w)) || (word === 'deno' && next[0] === 'eval'); // php -r, deno eval
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
  const text = joinContinuations(decodeAnsiCWords(command)).replace(GIT_TOPLEVEL, GIT_TOPLEVEL_WORD).replace(PLAIN_MKTEMP, MKTEMP_WORD);
  // a `$'...'` word decodes to text that can hold a quote the shell does not read as one (`$'\x27'`): no data argument is exempted then,
  // and no X10 mark is put on (its quotes are gone: `rm -rf $'>' ~/x`)
  const readsQuotes = !command.includes("$'");
  const withoutData = readsQuotes ? withoutInertArguments : (kept) => kept;
  const visible = withoutData(withoutPlainHeredocs(withoutMessageText(text)));
  const statements = statementsOf(visible, RUN_VALUE_ASSIGNMENT, readsQuotes);
  const otherHidden = HIDDEN_CONSTRUCT.test(visible) || statements.some(runsText);
  const gitHidden = GIT_FILE_CONFIG.test(visible) || hidesGitRun(visible);
  if (!otherHidden && !gitHidden) return undefined;
  const prodText = visible.toLowerCase();
  const prodNames = prodHosts.map((host) => host.replace(/[*?]/g, '')).filter(Boolean);
  const scanned = gitHidden ? statementsOf(visible, ANY_ASSIGNMENT, readsQuotes) : statements;
  const destructive = scanned.map((words) => dangerIn(words, prodText, prodNames));
  if (otherHidden && deletesInMovedText(visible, scanned)) destructive.push('destructive');
  const found = destructive.find((category) => category !== undefined);
  if (found === undefined) return BACKTICK_RUN_VALUE.test(visible) ? GIT_UNREADABLE_REASON : undefined;
  if (!otherHidden) return GIT_UNREADABLE_REASON;
  return destructive.includes('destructive') ? `${DESTRUCTIVE_PREFIX}${RISKY_REASON}` : RISKY_REASON;
}

export const UNREADABLE_NAME_REASON = 'a command name this guard cannot read (a character outside ASCII) next to a dangerous word; confirm it';
const NON_ASCII = /[^\x00-\x7F]/;
const NON_ASCII_WORD = /[^\s\x00-\x7F]+/g;

/**
 * A command word that still has a character outside ASCII after folding (lib/command-of.mjs commandCase) may be a look-alike of a real
 * command (`ѕh` with a Cyrillic letter, `ſh` on Linux): next to a dangerous word anywhere in the line it asks. The line's characters
 * outside ASCII are folded for that scan, so `ﬁnd ~ -delete` names find.
 * @param {string|undefined} cmd the command word as the guard named it (commandName)
 * @param {string} command the command line it is part of
 * @param {string[]} prodHosts production host names (see riskyWordInExpansion)
 * @returns {string[]} [UNREADABLE_NAME_REASON], or none
 */
export function unreadableNameReasons(cmd, command, prodHosts = []) {
  if (!NON_ASCII.test(cmd ?? '')) return [];
  const text = joinContinuations(decodeAnsiCWords(command)).replace(NON_ASCII_WORD, (chars) => chars.toUpperCase().toLowerCase());
  const visible = withoutPlainHeredocs(withoutMessageText(text));
  const prodText = visible.toLowerCase();
  const prodNames = prodHosts.map((host) => host.replace(/[*?]/g, '')).filter(Boolean);
  const dangerous = statementsOf(visible, ANY_ASSIGNMENT, !command.includes("$'")).some((words) => dangerIn(words, prodText, prodNames) !== undefined);
  return dangerous ? [UNREADABLE_NAME_REASON] : [];
}

/**
 * The quote-stripped words of each statement; the value of each `NAME=` word that `assignments` matches is split off as words. The X10
 * marks are put on first, while the quotes are still there (`marked`); `readsQuotes` is false for a line with a `$'...'` word.
 */
function statementsOf(visible, assignments, readsQuotes) {
  const plain = marked(visible.replace(NUL, ''), readsQuotes).replace(assignments, (assignment) => `${assignment} `).replace(/[\\'"]/g, '');
  return plain.split(STATEMENT_BREAK).map(wordsOf);
}

/** True when the line runs git and sets a variable or config key whose value git runs in a way the guard does not read to a literal. */
function hidesGitRun(text) {
  if (!GIT_COMMAND_WORD.test(text) || !UNREAD_VALUE.test(text)) return false;
  const isRunningKey = (word) => word.includes('.') && configKind(word.replace(/^[^A-Za-z]+/, '')) !== undefined;
  return GIT_RUN_VARIABLE.test(text) || text.split(KEY_BREAK).some(isRunningKey);
}
