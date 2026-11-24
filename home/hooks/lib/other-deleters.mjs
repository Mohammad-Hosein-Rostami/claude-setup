// Deleters other than `rm`, judged by the Bash guard on the same targets as `rm -r` (lib/rm-paths.mjs checkRm), and the text a shell,
// PowerShell, cmd or an interpreter is given to run. Read by pre-bash-guard.mjs.
// Exports: SHELLS; shellScript(args) -> the `-c` script | undefined; checkOtherDeleter(cmd, args, env) -> reason | undefined;
// checkLinkedDelete(commands) -> reason | undefined; withoutDotTargets(args).
// Judged (each asks when a target is outside the project, unknown, or a whole folder, as `rm -r` does):
// - rimraf, also run through npx, bunx, pnpx, `pnpm|yarn|bun|npm dlx|exec|x`;
// - `rsync --delete` (any `--del*` form): its destination, read as a bare glob of that folder (it empties what the source lacks); with
//   `-K`/`--keep-dirlinks` or `-k`/`--copy-dirlinks` it follows links into where they lead, so it always asks;
// - `powershell|pwsh -Command` text with Remove-Item or an alias of it (rm, rmdir, rd, del, erase, ri) and -Recurse (any prefix);
// - `cmd /c` (also `//c` from Git Bash, `/k`) text with `rd|rmdir /s` or `del|erase /s`;
// - `node|python|perl|ruby|deno|bun -e|-c|-p|--eval` (`php -r`, `deno eval`; lib/inline-code.mjs reads it) text with a recursive delete call (rmSync/rm/rmdir with `recursive: true`,
//   rmtree, remove_tree, FileUtils.rm_rf|rm_r|remove_dir|remove_entry): its first argument when it is a string literal; any other
//   argument (a variable, a joined path) asks, since the guard cannot read it.
// Also asks: a recursive delete (rm -r, rimraf, a deleting find) through a symlink a `ln -s` made earlier in the same line (it may
// point anywhere), and a command that may make links on a line where a scratch-area delete was let run (lib/scratch-area.mjs
// linkMakerReason: a loop, a pipe or `&` may run it first). Writes under ~/.claude/private and the guard's own state: lib/guard-state-write.mjs.
// withoutDotTargets drops `.` and `./` from rm's targets: rm refuses to remove them, so they never ask.
// Known limits (also named in pre-bash-guard.mjs): PowerShell -File and script blocks run later (-EncodedCommand asks:
// lib/inline-code.mjs); cmd text with `^` escapes or `%VAR%` paths (judged as written); interpreter code read from a file or stdin; a delete call reached through an alias
// or a loop; rimraf's own glob option.
// Invariants: reads the file system only through checkRm (lib/scratch-area.mjs); notes on the line's work budget which command may make
// links; every rule only adds asks,
// except withoutDotTargets, which removes only the two words rm itself refuses.
import { basename } from 'node:path';
import { interpreterCode } from './inline-code.mjs';
import { checkRm, RECURSIVE_FLAG, withoutRedirects } from './rm-paths.mjs';
import { linkMakerReason, linkState } from './scratch-area.mjs';
import { QUOTED_MARK, flagsOf } from './shell-words.mjs';
import { destructive, shown } from './verdict.mjs';

export const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/**
 * The `-c` script of a shell invocation: `-c` may sit anywhere in the option cluster or list (`-ec`, `-e -c`, `-c --`, `-o pipefail -c`).
 * @param {string[]} args words after the shell name
 * @returns {string | undefined} the script text, or undefined when this is not a `-c` call
 */
export function shellScript(args) {
  let hasC = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return hasC ? args[i + 1] : undefined;
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) i++;
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      hasC ||= arg.includes('c');
      if (/[oO]$/.test(arg)) i++; // `-eo pipefail`: the last letter takes the next word
    } else if (!arg.startsWith('-') && !arg.startsWith('+')) return hasC ? arg : undefined;
  }
  return undefined;
}

/**
 * checkRm's verdict on the targets of another deleter, worded for that deleter.
 * @param {string[]} targets the paths it deletes recursively, as written (an empty list: the targets could not be read)
 * @param {Parameters<typeof checkRm>[1]} env the segment's folder and variables
 * @param {string} name how the reason names the deleter
 * @returns {string | undefined} the ask reason, or undefined when every target is fine
 */
function judgeTargets(targets, env, name) {
  if (targets.length === 0) return destructive(`${name} with targets the guard cannot read; check them by hand`);
  return checkRm(['-r', ...targets], { ...env, groupTargets: [] })?.replace(/rm -r\b/, name);
}

const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const MANAGERS = new Set(['pnpm', 'yarn', 'bun', 'npm']);
const MANAGER_RUN_VERBS = new Set(['dlx', 'exec', 'x']);
const RIMRAF = /^rimraf(?:@[\w.^~<>=*-]+)?$/;

/** The targets of rimraf, run directly or through a package runner; undefined when this command runs no rimraf. */
function rimrafTargets(cmd, args) {
  const runs = PACKAGE_RUNNERS.has(cmd) || (MANAGERS.has(cmd) && MANAGER_RUN_VERBS.has(args[0]));
  const at = cmd === 'rimraf' ? -1 : runs ? args.findIndex((word) => RIMRAF.test(word)) : -1;
  if (cmd !== 'rimraf' && at === -1) return undefined;
  return withoutRedirects(args.slice(at + 1)).filter((word) => !word.startsWith('-'));
}

const RSYNC_DELETE = /^--del(?:$|ete(?:$|-))/;
// rsync options whose value is the next word, so it is not taken for a source or the destination
const RSYNC_VALUE_OPTIONS = new Set(['-e', '--rsh', '-f', '--filter', '--exclude', '--include', '--exclude-from', '--include-from',
  '--files-from', '-T', '--temp-dir', '--log-file', '--password-file', '--partial-dir', '--backup-dir', '--compare-dest', '--copy-dest',
  '--link-dest', '-B', '--block-size', '--chmod', '--chown', '--timeout', '--port', '--bwlimit', '-M', '--remote-option', '--suffix',
  '--out-format', '--rsync-path', '--max-size', '--min-size', '--usermap', '--groupmap', '--iconv', '--address']);
const REMOTE_PATH = /^(?![a-zA-Z]:[\\/])[^/]*:/; // `host:dir` or `rsync://`: lib/remote.mjs judges writes to a host
// `-K`/`--keep-dirlinks` treats a link to a folder in the destination as that folder, so --delete deletes inside where it leads;
// `-k`/`--copy-dirlinks` is named with it (it follows the source's folder links): both ask, whatever the destination
const RSYNC_FOLLOWS_LINKS = /^-[a-zA-Z]*[kK][a-zA-Z]*$|^--(?:keep|copy)-dirlinks$/;

/** The destination of an `rsync --delete` on this machine, undefined when there is none. */
function rsyncDestination(args) {
  if (!args.some((word) => RSYNC_DELETE.test(word))) return undefined;
  const positional = [];
  const words = withoutRedirects(args);
  for (let i = 0; i < words.length; i++) {
    if (RSYNC_VALUE_OPTIONS.has(words[i])) i++;
    else if (!words[i].startsWith('-')) positional.push(words[i]);
  }
  const destination = positional.length >= 2 ? positional.at(-1) : undefined;
  return destination === undefined || REMOTE_PATH.test(destination) ? undefined : destination;
}

const WINDOWS_DRIVE = /^([a-zA-Z]):(?=\/|$)/;
const DRIVE_RELATIVE = /^[a-zA-Z]:(?!\/)/; // `C:Users`: relative to the folder Windows remembers for drive C, which the guard cannot know
/**
 * A Windows path as the guard's path rules read it: backslashes become slashes and `C:/x` becomes the Git Bash `/c/x`; a drive-relative
 * path gets a `$` in front, so the rules treat it as unknown and ask.
 */
function posixPath(path) {
  const slashed = path.replaceAll('\\', '/');
  return DRIVE_RELATIVE.test(slashed) ? `$${slashed}` : slashed.replace(WINDOWS_DRIVE, (_, drive) => `/${drive.toLowerCase()}`);
}
const unquote = (word) => word.replace(/^(['"])([\s\S]*)\1$/, '$2');
/** The words of one statement of PowerShell or cmd text: quoted runs stay whole, quotes are dropped. */
const textWords = (statement) => (statement.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);

const POWERSHELLS = /^(?:powershell|pwsh)(?:\.exe)?$/i;
const WINDOWS_POWERSHELL = /^powershell(?:\.exe)?$/i;
const PS_COMMAND_FLAG = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i; // PowerShell takes any prefix of -Command
const PS_REMOVERS = new Set(['remove-item', 'rm', 'rmdir', 'rd', 'del', 'erase', 'ri']);
const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$true)?$/i;
const PS_PATH_PARAMS = /^-(?:path|literalpath|lp|pspath)$/i;
const PS_VALUE_PARAMS = /^-(?:include|exclude|filter|credential|stream)$/i;
const PS_STATEMENT_BREAK = /;|\n|\|\||&&|\|/;

/** The paths of one PowerShell statement that removes recursively; undefined when it does not. */
function powerShellTargets(words) {
  if (!PS_REMOVERS.has((words[0] ?? '').replace(/^&\s*/, '').toLowerCase()) || !words.some((word) => PS_RECURSE.test(word))) return undefined;
  const targets = [];
  for (let i = 1; i < words.length; i++) {
    if (PS_PATH_PARAMS.test(words[i])) targets.push(words[++i] ?? '');
    else if (PS_VALUE_PARAMS.test(words[i])) i++;
    else if (!words[i].startsWith('-')) targets.push(words[i]);
  }
  return targets.flatMap((target) => target.split(',')).filter(Boolean).map(posixPath);
}

const CMDS = /^cmd(?:\.exe)?$/i;
const CMD_RUN_FLAG = /^\/{1,2}[ck]$/i;
const CMD_REMOVERS = /^(?:rd|rmdir|del|erase)$/i;
const CMD_SWITCHES = /^(?:\/[a-z?](?::[a-z-]*)?)+$/i; // `/s`, `/q`, `/s/q`, `/a:h`; `/work/x` is a path
const CMD_STATEMENT_BREAK = /&&|\|\||[&|\n]/;

/** The paths of one cmd statement that removes a tree (`rd /s`, `del /s`); undefined when it does not. */
function cmdTargets(words) {
  if (!CMD_REMOVERS.test(words[0] ?? '')) return undefined;
  const switches = words.filter((word) => CMD_SWITCHES.test(word));
  if (!switches.some((word) => /\/s(?:\/|$)/i.test(word))) return undefined;
  return words.slice(1).filter((word) => !CMD_SWITCHES.test(word)).map(posixPath);
}

/** The text a PowerShell or cmd command runs, and how to read its statements; undefined for any other command. */
function windowsScript(cmd, args) {
  const isPowerShell = POWERSHELLS.test(cmd);
  if (!isPowerShell && !CMDS.test(cmd)) return undefined;
  const flagAt = args.findIndex((word) => (isPowerShell ? PS_COMMAND_FLAG : CMD_RUN_FLAG).test(word));
  // Windows PowerShell runs its words as a command when they start with no option (pwsh reads the first one as a script file)
  const runsWords = flagAt === -1 && WINDOWS_POWERSHELL.test(cmd) && args.length > 0 && !args[0].startsWith('-');
  if (flagAt === -1 && !runsWords) return undefined;
  const at = runsWords ? -1 : flagAt;
  return isPowerShell
    ? { text: args.slice(at + 1).join(' '), breaks: PS_STATEMENT_BREAK, targets: powerShellTargets, name: `${cmd} Remove-Item -Recurse` }
    : { text: args.slice(at + 1).join(' '), breaks: CMD_STATEMENT_BREAK, targets: cmdTargets, name: `${cmd} rd /s` };
}

/** The first reason of any statement of a PowerShell or cmd script that removes a tree. */
function checkWindowsScript(cmd, args, env) {
  const script = windowsScript(cmd, args);
  if (script === undefined) return undefined;
  for (const statement of script.text.split(script.breaks)) {
    const targets = script.targets(textWords(statement));
    const reason = targets === undefined ? undefined : judgeTargets(targets, env, script.name);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

// rmtree (Python shutil, Perl File::Path), remove_tree (Perl), FileUtils.rm_rf & co (Ruby); Node's calls count only with `recursive: true`
const TREE_CALL = /\b(?:rmtree|remove_tree|rm_rf|rm_r|remove_dir|remove_entry_secure|remove_entry)\b/g;
const NODE_CALL = /\b(?:rmSync|rmdirSync|rm|rmdir)\s*(?=\()/g;
const NODE_RECURSIVE = /\brecursive\s*:\s*true\b/;
// the first argument when it is one string literal: `('.')`, ` '.'` (Ruby without parentheses), `(r'/x',` (a Python prefix)
const CALL_START = /^\s*\(|^\s+['"`]/; // `rmtree(`, `rm_rf '.'`; `import rmtree` names it without calling it
const LITERAL_ARGUMENT = /^(?:\s*\(\s*|\s+)([rRbBuUfF]{0,2})(['"`])([^'"`\n]{0,4096})\2\s*(?=[,)\s;]|$)/;

/** The first argument of each recursive delete call in the code: a literal path, or null when the guard cannot read it. */
function deleteCallPaths(code) {
  const calls = [...code.matchAll(TREE_CALL), ...(NODE_RECURSIVE.test(code) ? code.matchAll(NODE_CALL) : [])];
  return calls.flatMap((call) => {
    const rest = code.slice(call.index + call[0].length);
    if (!CALL_START.test(rest)) return [];
    const literal = LITERAL_ARGUMENT.exec(rest);
    if (literal === null) return [null];
    const [, prefix, quote, path] = literal;
    const interpolates = (quote === '`' && path.includes('${')) || (/f/i.test(prefix) && path.includes('{'));
    return [interpolates ? null : path];
  });
}

/** The reason when interpreter code on the command line deletes a tree the guard must judge. */
function checkInterpreterCode(cmd, args, env) {
  const code = interpreterCode(cmd, args);
  if (typeof code !== 'string') return undefined;
  const paths = deleteCallPaths(code);
  if (paths.length === 0) return undefined;
  if (paths.includes(null)) return destructive(`${cmd} code deletes a folder tree at a path the guard cannot read; check it by hand`);
  return judgeTargets(paths, env, `${cmd} code deleting a tree`);
}

/**
 * Deleters other than rm, judged on rm -r's target rules.
 * @param {string} cmd the command name (lib/command-of.mjs)
 * @param {string[]} args its words
 * @param {Parameters<typeof checkRm>[1]} env the segment's folder and variables, as for checkRm
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkOtherDeleter(cmd, args, env) {
  const links = env.work === undefined ? undefined : linkState(env.work, env.parse);
  const deletedBefore = links?.scratchDelete; // what this command deletes itself is not a delete its own links could reach first
  const reason = deleterReason(cmd, args, env);
  // rimraf run through npx & co deletes and makes no link; any other command that may make one is noted (lib/scratch-area.mjs)
  const linkReason = rimrafTargets(cmd, args) === undefined ? linkMakerReason(cmd, args, links, deletedBefore) : undefined;
  return reason ?? linkReason;
}

/** The ask reason of rimraf, rsync --delete, PowerShell, cmd or interpreter code deleting a tree; undefined for anything else. */
function deleterReason(cmd, args, env) {
  const rimraf = rimrafTargets(cmd, args);
  if (rimraf !== undefined) return judgeTargets(rimraf, env, 'rimraf');
  const destination = cmd === 'rsync' ? rsyncDestination(args) : undefined;
  if (destination !== undefined && args.some((word) => RSYNC_FOLLOWS_LINKS.test(word))) {
    return destructive(`rsync --delete that follows the links in its destination (${shown(destination)}): it may delete where they lead`);
  }
  if (destination !== undefined) return judgeTargets([`${destination.replace(/\/+$/, '')}/*`], env, 'rsync --delete');
  return checkWindowsScript(cmd, args, env) ?? checkInterpreterCode(cmd, args, env);
}

const SYMLINK_FLAG = /^-[a-zA-Z]*s|^--symbolic$/;
const FIND_DELETES = /^-(?:delete|exec|execdir|ok|okdir)$/;
const LINK_UNSEEN = 'the guard cannot see where it points';
const isThrough = (path, link) => path === link || path.startsWith(`${link}/`);
const linkKey = (path) => path.replace(QUOTED_MARK, '').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

/** The name a `ln -s` creates (the last word, or the target's own name when only the target is given); [] for any other command. */
function linkNames({ cmd, args }) {
  if (cmd !== 'ln' || !flagsOf(args).some((flag) => SYMLINK_FLAG.test(flag))) return [];
  const words = withoutRedirects(args).filter((word) => !word.startsWith('-'));
  return words.length >= 2 ? [linkKey(words.at(-1))] : words.map((word) => basename(linkKey(word)));
}

/** True when this command deletes recursively: rm -r, rimraf, or a find that deletes or runs a command. */
function deletesTree({ cmd, args }) {
  if (cmd === 'rm') return flagsOf(args).some((flag) => RECURSIVE_FLAG.test(flag));
  return cmd === 'rimraf' || (cmd === 'find' && args.some((word) => FIND_DELETES.test(word))) || rimrafTargets(cmd, args) !== undefined;
}

/**
 * A recursive delete through a link the same line made: `ln -s .. up && rm -rf up/*` empties the folder above. The path rules read
 * paths as written and never follow a link, so such a delete asks.
 * @param {{cmd?: string, args: string[]}[]} commands the line's commands in order
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkLinkedDelete(commands) {
  const links = new Set();
  for (const command of commands) {
    if (command.cmd === undefined) continue;
    const through = deletesTree(command)
      ? command.args.filter((word) => !word.startsWith('-')).map(linkKey).find((path) => [...links].some((link) => isThrough(path, link)))
      : undefined;
    if (through !== undefined) return destructive(`a recursive delete through a link made in the same line (${shown(through)}): ${LINK_UNSEEN}`);
    for (const name of linkNames(command)) if (name !== '') links.add(name);
  }
  return undefined;
}

const DOT_ONLY = /^\.\/*$/;
/**
 * rm's targets without `.` and `./`, which rm refuses to remove (GNU and BSD alike), so `rm -rf .` is no whole-folder delete.
 * A line whose rm words hold an expansion keeps every word: the shell may turn them into anything; so does an rm with a glob group
 * after it (`./(*)`: the `./` is glued to the group, not a target of its own).
 * @param {string[]} args words after `rm`
 * @param {string[]} [groupTargets] the branches of a glob group written after the rm (lib/bare-glob.mjs groupBranches)
 * @returns {string[]} the words to judge
 */
export function withoutDotTargets(args, groupTargets = []) {
  if (groupTargets.length > 0 || args.some((word) => /[$`]/.test(word))) return args;
  return args.filter((word) => !DOT_ONLY.test(word.replace(QUOTED_MARK, '')));
}
