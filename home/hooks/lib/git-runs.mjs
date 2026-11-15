// The commands git itself runs, read off one git command: the Bash guard checks each like a `bash -c` body and their reasons join the git
// command's (pre-bash-guard.mjs checkCommand). Exports: gitRunReasons(command, env, reasonsOf) -> string[]; GIT_UNREADABLE_REASON;
// COMMAND_ENV and configKind(name), which lib/raw-risk.mjs reads to find what git runs in raw text.
// Forms (git 2.54: each command's `git help`, `git help config|git`, git-hook, git-remote-ext; the quoting probed on the installed git):
// - COMMAND_OPTIONS: `rebase -x|--exec`, `filter-branch --*-filter|--setup`, `grep -O<pager>`, `clone -u|--upload-pack` ...; a long option
//   also as a prefix (git takes a unique one), a short one stuck on or in a cluster (`-xcmd`, `-ix cmd`);
// - word lists: `bisect run <words>` (git quotes each word), `submodule foreach <cmd> [<words>]` (git runs the first as shell text with
//   the rest as its arguments), `for-each-repo <words>` (`git <words>` in other repositories, so in a directory the guard does not know);
// - config for this call (`-c`, `--config-env` with its variable assigned in the line, GIT_CONFIG_KEY_<n>/VALUE_<n>, GIT_CONFIG_PARAMETERS,
//   clone's own `-c|--config`) and what `git config` writes: COMMAND_CONFIG keys run their value (section and key in any case, any
//   subsection), `alias.*` runs `!<shell text>` or else git with the value as its words, `remote.*.vcs` runs `git remote-<value>`, and
//   core.hooksPath asks as `-c` does; COMMAND_ENV variables set in front of git (also by `env`) or earlier in the line; `ext::<command>`
//   URLs among git's words and config values, and `git remote-ext <remote> <command>` (git-remote-ext splits it at unescaped spaces).
// A config or environment value that is a variable or substitution is not a "variable command word" ask (`GIT_PAGER="$P" git log` stays
// silent; lib/raw-risk.mjs still asks next to a dangerous word); an option value is a `bash -c` body in every way. GIT_UNREADABLE_REASON
// asks for a `--config-env` variable the line does not set (EDITOR-style variables excepted), a GIT_CONFIG_KEY_<n> without its value,
// `ext::` switched on (protocol.ext.allow, protocol.allow, GIT_ALLOW_PROTOCOL) and word lists that differ between readings of git's
// options. Config files and values set in ways the guard cannot read (`declare -x`, `printf -v`, `"$A$B"`) are lib/raw-risk.mjs's job.
// `-C <dir>` moves the commands; --git-dir, --work-tree, GIT_DIR and GIT_WORK_TREE make their directory unknown (null).
// Pure, no I/O. Each subcommand's options are read once, each distinct command is checked once, and the caller's MAX_NESTING bounds depth.
import { resolve } from 'node:path';
import { configOf, HOOKS_PATH_REASON } from './command-checks.mjs';
import { parseGitArgs } from './git-options.mjs';
import { expandHome, nativePath, withoutRedirects } from './rm-paths.mjs';
import { CONVENTIONAL_COMMAND_VARS, SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { QUOTED_MARK, segments } from './shell-words.mjs';

export const GIT_UNREADABLE_REASON = 'git runs a command this guard cannot read (a variable this command line does not set, or ext:: '
  + 'remotes switched on); confirm it';

const longOptions = (...names) => names.map((long) => ({ long, short: '' }));
// subcommand -> the options whose value git runs: the long name, the short letter ('' for none), and attachedOnly when the value is
// optional and must be stuck to the option (`grep -O<pager>`; `-O` alone uses the configured pager, read as config)
const COMMAND_OPTIONS = new Map([
  ['rebase', [{ long: '--exec', short: 'x' }]], ['difftool', [{ long: '--extcmd', short: 'x' }]], ['clone', [{ long: '--upload-pack', short: 'u' }]],
  ['grep', [{ long: '--open-files-in-pager', short: 'O', attachedOnly: true }]],
  ['am', longOptions('--exec')], // not in git 2.54 (git rejects it); read like rebase's, should a later git add it
  ['fetch', longOptions('--upload-pack')], ['pull', longOptions('--upload-pack')], ['archive', longOptions('--exec')], ['daemon', longOptions('--access-hook')],
  ['ls-remote', longOptions('--upload-pack', '--exec')], ['fetch-pack', longOptions('--upload-pack', '--exec')],
  ['push', longOptions('--receive-pack', '--exec')], ['send-pack', longOptions('--receive-pack', '--exec')],
  ['filter-branch', longOptions('--setup', '--env-filter', '--tree-filter', '--index-filter', '--parent-filter', '--msg-filter', '--commit-filter',
    '--tag-name-filter')],
  ['send-email', longOptions('--sendmail-cmd', '--to-cmd', '--cc-cmd', '--header-cmd', '--smtp-server')],
]);
// subcommand -> its own option that sets config for the call: only clone in git 2.54 (`-c|--config <key>=<value>`, used during the
// clone); `for-each-repo --config` and `web--browse --config` name a key, `maintenance --config-file` a file
const CONFIG_OPTIONS = new Map([['clone', [{ long: '--config', short: 'c' }]]]);
// config `section.key` (lowercase, a subsection dropped: `diff.<driver>.textconv` is diff.textconv) whose value git runs; `*.path` keys
// name the program of a difftool, mergetool, browser or man viewer
const COMMAND_CONFIG = new Set(['core.pager', 'core.editor', 'core.sshcommand', 'core.fsmonitor', 'core.askpass', 'core.gitproxy',
  'core.alternaterefscommand', 'sequence.editor', 'credential.helper', 'diff.external', 'diff.textconv', 'diff.command', 'merge.driver',
  'mergetool.cmd', 'mergetool.path', 'difftool.cmd', 'difftool.path', 'filter.clean', 'filter.smudge', 'filter.process', 'gpg.program',
  'gpg.defaultkeycommand', 'uploadpack.packobjectshook', 'remote.uploadpack', 'remote.receivepack', 'browser.cmd', 'browser.path',
  'man.cmd', 'man.path', 'interactive.difffilter', 'gc.recentobjectshook', 'guitool.cmd', 'imap.tunnel', 'trailer.command', 'trailer.cmd',
  'submodule.update', 'tar.command', 'hook.command']);
const COMMAND_SECTIONS = new Set(['pager', 'instaweb']); // `pager.<command>`, and every instaweb key (httpd, browser ...)
const SENDEMAIL_COMMAND = /cmd$|^smtpserver$/; // sendemail.sendmailCmd, toCmd, ccCmd, headerCmd, smtpServer (also per identity)
// environment variables whose value git runs (`git help git`, `git help config`); EDITOR, VISUAL and PAGER are git's fallbacks
const CONFIG_COMMAND = new Set(['config']);
const EXT_HELPER = new Set(['remote-ext']); // `git remote-ext <remote> <command>`, the helper behind `ext::` (remote-fd runs no command)
export const COMMAND_ENV = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'PAGER', 'EDITOR', 'VISUAL',
  'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND'];
const ASSIGNMENT = /^([A-Za-z_]\w*)=([\s\S]*)$/;
const UNREADABLE_NAME = /[$`]/;
const EXT_URL = /(?:^|=)ext::([\s\S]*)$/i;
const EXT_SKIPPED_WORD = /^%[GV]/; // git-remote-ext does not pass `%G...` and `%V...` words to the command
const MOVES_WORK_TREE = /^--(?:git-dir|work-tree)(?:=|$)/;
const CONFIG_ENV_OPTION = '--config-env';
const LONG_PREFIX = '--'; // alone, the word that ends a list of options
const FOR_EACH_REPO_CONFIG = '--config'; // for-each-repo's option that takes a value
const FOR_EACH_REPO_FLAGS = ['--keep-going', '--no-keep-going'];
const PROTOCOL_OFF = 'never';
const VARIABLE_COMMAND_REASONS = new Set([VARIABLE_COMMAND_REASON, SPLIT_VARIABLE_REASON]);

const plain = (word) => (word.startsWith(QUOTED_MARK) ? word.slice(QUOTED_MARK.length) : word);
/** One word in single quotes, as git quotes the words of `bisect run`: the shell reads it back as exactly that word. */
const quoted = (word) => `'${plain(word).replaceAll("'", "'\\''")}'`;
const quotedWords = (words) => withoutRedirects(words).map(quoted).join(' ');

/** Index of the first word at or after `from` that is not an option; words.length when there is none. */
function firstPlainWord(words, from) {
  const at = words.slice(from).findIndex((word) => !word.startsWith('-'));
  return at === -1 ? words.length : from + at;
}

/**
 * The value of one command option in a word (and the next word): `--exec=cmd`, `--exec cmd`, a prefix such as `--ex cmd`, `-x cmd`,
 * `-xcmd`, or the letter in a cluster (`-ix cmd`). An attachedOnly option has a value only when it is stuck to it.
 * @returns {string | undefined} the command, or undefined when the word is not this option
 */
function optionValue(word, next, { long, short, attachedOnly = false }) {
  if (word.startsWith(LONG_PREFIX)) {
    const equals = word.indexOf('=');
    const name = equals === -1 ? word : word.slice(0, equals);
    if (name.length <= LONG_PREFIX.length || !long.startsWith(name)) return undefined;
    if (equals !== -1) return word.slice(equals + 1);
    return attachedOnly ? undefined : next;
  }
  const at = short !== '' && word.startsWith('-') ? word.indexOf(short, 1) : -1;
  if (at === -1) return undefined;
  const attached = word.slice(at + 1);
  return attached !== '' || attachedOnly ? attached : next;
}

/** subcommand name (one of `names`) -> the words after it in its longest reading, which holds the words of every later reading. */
function longestReadings(subcommands, names) {
  const longest = new Map();
  for (const { sub, rest } of subcommands) {
    if (names.has(sub) && rest.length >= (longest.get(sub)?.length ?? 0)) longest.set(sub, rest);
  }
  return longest;
}

/** The values of the options of `optionsBySub` (subcommand -> option specs), each subcommand read once in its longest reading. */
function optionValues(subcommands, optionsBySub) {
  const readings = [...longestReadings(subcommands, optionsBySub)];
  const values = readings.flatMap(([sub, rest]) => rest.flatMap((word, i) => optionsBySub.get(sub).map((option) => optionValue(word, rest[i + 1], option))));
  return values.filter((value) => value !== undefined);
}

/** True when this reading of git's words runs a word list: `bisect run ...`, `submodule [options] foreach ...`, `for-each-repo ...`. */
function runsList({ sub, rest }) {
  if (sub === 'bisect') return rest[0] === 'run';
  if (sub === 'submodule') return rest[firstPlainWord(rest, 0)] === 'foreach';
  return sub === 'for-each-repo';
}

/** Words one for-each-repo option takes (git 2.54): 2 for `--config <name>`, 1 for `--config=<name>` or `--[no-]keep-going` (or a prefix), else 0. */
function forEachRepoOptionLength(word = '') {
  const [name] = word.split('=');
  const prefixOf = (option) => name.length > LONG_PREFIX.length && option.startsWith(name);
  if (prefixOf(FOR_EACH_REPO_CONFIG)) return word.includes('=') ? 1 : 2;
  return !word.includes('=') && FOR_EACH_REPO_FLAGS.some(prefixOf) ? 1 : 0;
}

/** The git words of for-each-repo, after its options and `--`; an option it does not know starts them (lib/git-options.mjs reads it both ways). */
function forEachRepoWords(rest) {
  let i = 0;
  for (let length = forEachRepoOptionLength(rest[i]); length > 0; length = forEachRepoOptionLength(rest[i])) i += length;
  return rest.slice(rest[i] === LONG_PREFIX ? i + 1 : i);
}

/** The command line one word-list reading runs: {text, elsewhere} (elsewhere: it runs in other repositories). */
function listCommand({ sub, rest }) {
  if (sub === 'bisect') return { text: quotedWords(rest.slice(1)) };
  if (sub === 'for-each-repo') return { text: `git ${quotedWords(forEachRepoWords(rest))}`, elsewhere: true };
  const [command = '', ...words] = withoutRedirects(rest.slice(firstPlainWord(rest, firstPlainWord(rest, 0) + 1)));
  return { text: `${plain(command)} ${quotedWords(words)}` }; // git runs `sh -c '<command> "$@"' <command> <words>`
}

/** name -> every value assigned to it in front of git (`X=1 git`, `env X=1 git`) and, when the guard knows it, earlier in the line. */
function assignmentsOf(before, vars) {
  const prefix = new Map();
  for (const match of before.map((word) => ASSIGNMENT.exec(word))) {
    if (match !== null) prefix.set(match[1], [...(prefix.get(match[1]) ?? []), match[2]]);
  }
  return (name) => [...(prefix.get(name) ?? []), ...(vars.has(name) ? [vars.get(name)] : [])];
}

/** `name=value` -> {name, value}; a name alone (git reads it as true) has no value to run. */
const pairOf = (text) => (text.includes('=') ? { name: text.slice(0, text.indexOf('=')), value: text.slice(text.indexOf('=') + 1) } : { name: text });

/** GIT_CONFIG_KEY_<n> with GIT_CONFIG_VALUE_<n>, n from 0 up to the first n with neither; a missing name or value is unknown. */
function numberedConfig(valuesOf) {
  const entries = [];
  for (let n = 0; valuesOf(`GIT_CONFIG_KEY_${n}`).length + valuesOf(`GIT_CONFIG_VALUE_${n}`).length > 0; n += 1) {
    const values = valuesOf(`GIT_CONFIG_VALUE_${n}`);
    const names = valuesOf(`GIT_CONFIG_KEY_${n}`);
    for (const name of names.length > 0 ? names : [undefined]) {
      entries.push(...(values.length > 0 ? values.map((value) => ({ name, value })) : [{ name, variable: `GIT_CONFIG_VALUE_${n}` }]));
    }
  }
  return entries;
}

/** Every config this git command sets, {name, value} or {name, variable} (a `--config-env` variable this line does not assign). */
function configEntries(options, subcommands, valuesOf) {
  const fromOptions = options.flatMap((option) => {
    const text = configOf(option);
    if (text === undefined || !option[0].startsWith(CONFIG_ENV_OPTION)) return text === undefined ? [] : [pairOf(text)];
    const name = text.slice(0, Math.max(0, text.lastIndexOf('=')));
    const variable = text.slice(text.lastIndexOf('=') + 1);
    const values = valuesOf(variable);
    return values.length > 0 ? values.map((value) => ({ name, value })) : [{ name, variable }];
  });
  const parameters = valuesOf('GIT_CONFIG_PARAMETERS').flatMap((text) => segments(text).flat().map(pairOf));
  const fromSubcommands = [...optionValues(subcommands, CONFIG_OPTIONS).map(pairOf), ...configWrites(longestReadings(subcommands, CONFIG_COMMAND).get('config'))];
  return [...fromOptions, ...parameters, ...numberedConfig(valuesOf), ...fromSubcommands];
}

/**
 * What `git config [set] [--add|--replace-all] [--global|--file <f>] <name> <value>` writes: {name, value} for each command-running key
 * and the plain word after it (option words skipped). A read has no value after the key, or a value pattern, checked the same way (rare).
 */
function configWrites(rest = []) {
  const words = rest.filter((word) => !word.startsWith('-'));
  return words.flatMap((name, i) => (i + 1 < words.length && configKind(name) !== undefined ? [{ name, value: words[i + 1] }] : []));
}

/** What git does with config `name`'s value: 'command', 'alias', 'vcs', 'protocol' (ext:: on), 'hooks' (core.hooksPath) or undefined. */
export function configKind(name) {
  const parts = name.toLowerCase().split('.');
  const [section] = parts;
  const key = parts.length > 1 ? parts.at(-1) : '';
  if (UNREADABLE_NAME.test(name)) return 'command'; // a name the guard cannot read may name any of them
  if (section === 'alias') return 'alias';
  if (`${section}.${key}` === 'remote.vcs') return 'vcs';
  if (`${section}.${key}` === 'core.hookspath') return 'hooks';
  if (`${section}.${key}` === 'protocol.allow') return parts.length === 2 || parts[1] === 'ext' ? 'protocol' : undefined;
  const runs = COMMAND_CONFIG.has(`${section}.${key}`) || COMMAND_SECTIONS.has(section) || (section === 'sendemail' && SENDEMAIL_COMMAND.test(key));
  return runs ? 'command' : undefined;
}

/** What git runs for one config entry: {text} (a command line), {ask} (what it cannot read), or {} (nothing). */
function configRun({ name, value, variable }) {
  const kind = name === undefined ? 'command' : configKind(name);
  if (kind === undefined) return {};
  if (kind === 'hooks') return { ask: HOOKS_PATH_REASON };
  if (variable !== undefined) return CONVENTIONAL_COMMAND_VARS.has(variable) ? {} : { ask: GIT_UNREADABLE_REASON };
  if (value === undefined || value === '') return {};
  if (kind === 'protocol') return value.toLowerCase() === PROTOCOL_OFF ? {} : { ask: GIT_UNREADABLE_REASON };
  if (kind === 'alias') return { text: value.startsWith('!') ? value.slice(1) : `git ${value}` };
  return { text: kind === 'vcs' ? `git remote-${value}` : value.replace(/^!/, '') }; // `!cmd` helpers and submodule updates run cmd
}

/** The command of an `ext::` URL as a command line: git-remote-ext splits it at unescaped spaces; `% ` is a space and `%%` a percent. */
function extCommand(url) {
  const words = [''];
  for (let i = 0; i < url.length; i += 1) {
    const escaped = url[i] === '%' && (url[i + 1] === ' ' || url[i + 1] === '%');
    if (escaped) i += 1; // the escaped character is kept below
    if (url[i] === ' ' && !escaped) words.push('');
    else words[words.length - 1] += url[i];
  }
  return words.filter((word) => word !== '' && !EXT_SKIPPED_WORD.test(word)).map(quoted).join(' ');
}

/** The directory git runs the commands in: the shell's, moved by each `-C <dir>`; null when it cannot be known. */
function innerCwd(options, cwd, valuesOf) {
  if (valuesOf('GIT_DIR').length + valuesOf('GIT_WORK_TREE').length > 0) return null;
  let dir = cwd;
  for (const [word, value = '$'] of options) {
    if (MOVES_WORK_TREE.test(word)) return null;
    if (word !== '-C') continue;
    const target = expandHome(value); // a missing value or `~user` stays unknown
    dir = dir === null || UNREADABLE_NAME.test(target) || target.startsWith('~') ? null : resolve(dir, nativePath(target));
  }
  return dir;
}

/** What this git command makes git run, as {runs: [{text, cwd, value?}], asks}; value marks a config or environment value. */
function commandsOf({ args, before }, env) {
  const valuesOf = assignmentsOf(before, env.vars ?? new Map());
  const { options, subcommands } = parseGitArgs(args);
  const entries = configEntries(options, subcommands, valuesOf);
  const fromConfig = entries.map(configRun);
  const lists = subcommands.filter(runsList); // differing readings would each need their own list: ask instead of checking them all
  const extOn = valuesOf('GIT_ALLOW_PROTOCOL').some((list) => list.toLowerCase().split(':').includes('ext'));
  const asks = [...fromConfig.map((run) => run.ask), extOn || lists.length > 1 ? GIT_UNREADABLE_REASON : undefined];
  const cwd = innerCwd(options, env.cwd, valuesOf);
  const urls = [...args.map(plain), ...entries.map((entry) => entry.value ?? '')].map((word) => EXT_URL.exec(word)?.[1]).filter((url) => url !== undefined);
  const helperCommands = (longestReadings(subcommands, EXT_HELPER).get('remote-ext') ?? []).map(plain);
  const list = lists.length === 1 ? listCommand(lists[0]) : undefined;
  const runs = [
    ...[...optionValues(subcommands, COMMAND_OPTIONS), ...[...urls, ...helperCommands].map(extCommand)].map((text) => ({ text, cwd })),
    ...[...fromConfig.map((run) => run.text), ...COMMAND_ENV.flatMap(valuesOf)].map((text) => ({ text, cwd, value: true })),
    ...(list === undefined ? [] : [{ text: list.text, cwd: list.elsewhere ? null : cwd }]),
  ];
  return { runs, asks: asks.filter((ask) => ask !== undefined) };
}

/**
 * Every reason the commands git itself runs for this git command give, each checked by the guard's own rules as a nested body.
 * @param {{args: string[], before?: string[]}} command the words after `git`, and the words before it in its simple command (prefix
 *   assignments, `env X=1`, wrappers)
 * @param {{cwd: string|null, vars?: Map<string, string>}} env the guard's env for this command (its depth already one deeper); vars holds
 *   the literal values assigned earlier in the line
 * @param {(text: string, env: object) => string[]} reasonsOf the guard's check of a command line, called with `env` and the inner cwd
 * @returns {string[]} ask reasons, empty when every command git runs is fine; a config or environment value that is a variable is not
 *   itself a reason (see the header)
 */
export function gitRunReasons({ args, before = [] }, env, reasonsOf) {
  const { runs, asks } = commandsOf({ args, before }, env);
  const checked = new Set();
  const reasons = runs.flatMap(({ text, cwd, value = false }) => {
    const key = JSON.stringify([text, cwd, value]);
    if (text === undefined || text.trim() === '' || checked.has(key)) return [];
    checked.add(key);
    const found = reasonsOf(plain(text), { ...env, cwd });
    return value ? found.filter((reason) => !VARIABLE_COMMAND_REASONS.has(reason)) : found;
  });
  return [...new Set(asks), ...reasons];
}
