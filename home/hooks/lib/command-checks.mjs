// Per-command rules of pre-bash-guard that need only one command's name and words: git, disk wipes, lockfile hand edits,
// a variable used as the command name with rm-style flags, rm -r run by xargs or parallel (also inside the `sh -c` script they run), and
// printing a stored secret (keychain, `gh auth token`), and `gh ssh-key add` of a file that is not `*.pub`.
// Exports: checkGit(args, assigns), checkDiskWipe(cmd, args), checkLockfileEdit(cmd, args), checkHiddenRm(cmd, args),
// checkStdinRm(cmd, args, before), checkStdinScriptRm(script, before), checkKeychainPrint(cmd, args), checkGhSecret(cmd, args) - each
// returns an ask reason, or undefined when the command is fine; secretPrintOf(cmd, args) and isSecretPrintReason(reason) serve
// lib/captured-read.mjs; LOCKFILES and lockfileAdvice(name) serve lib/reason-classes.mjs; configOf(option) and HOOKS_PATH_REASON serve lib/git-runs.mjs.
// Pure, no I/O. Every rule is an ask (the hook shows a timed dialog); a destructive one starts with "DESTRUCTIVE: ". The one exception is
// checkLockfileEdit: a quality rule, its text is advice (lib/bounce-once.mjs: denied once with the fix, the identical retry runs).
// git's own options before the subcommand are read by lib/git-options.mjs; when they can be read more than one way, every reading is checked.
import { isAccountTokenRead } from './account-reads.mjs';
import { commandName, commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { parsePushArgs, pushAsk } from './outward.mjs';
import { RECURSIVE_FLAG } from './rm-paths.mjs';
import { OUTPUT_REDIRECT, basenameOf, flagsOf, segments } from './shell-words.mjs';
import { DESTRUCTIVE_PREFIX, destructive } from './verdict.mjs';

export const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);
// rm is allowed on lockfiles (delete and reinstall is a normal fix); cp only writes its last argument.
const FILE_WRITERS = new Set(['mv', 'cp', 'tee', 'truncate']);
const CONFIG_ENV_ATTACHED = '--config-env=';
const NO_VERIFY = '--no-verify';
const MIN_NO_VERIFY_PREFIX = 8; // `--no-ver`: git accepts any unique prefix of a long option
const DISK_DEVICE = /^\/dev\/(?!null$|zero$|tty|std|fd\/|pts\/)/;
const MKFS_COMMAND = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?)$/; // mkfs.ext4, newfs_hfs
const DISKUTIL_WIPE = /^(?:erase|partition|zero|secureerase|reformat|apfs(?:delete|erase))/i;
const DISKUTIL_APFS_WIPE = /^(?:delete|erase)/i; // `diskutil apfs deleteContainer`, `apfs eraseVolume`
const DEVICE_WRITERS = new Set(['cp', 'mv', 'install', 'tee']); // diskutil eraseDisk, partitionDisk, zeroDisk, secureErase, reformat
const RAW_DEVICE_TARGET = /^\/dev\/(?:r?disk|sd|hd|nvme|vd|xvd|mmcblk)/; // `> /dev/disk2`, `>/dev/sda`
// `git -c core.hooksPath=x` replaces the repo hooks for one command
export const HOOKS_PATH_REASON = 'git -c core.hooksPath bypasses the git hooks';
const isHooksPathConfig = (value = '') => /^core\.hookspath=/i.test(value);
// `git -c alias.p=push p`, `git -c 'alias.x=!git push' x`: the alias hides what runs
const isAliasConfig = (value = '') => /^alias\./i.test(value);
const isLockfile = (p) => LOCKFILES.has(basenameOf(p));

/**
 * The config one git option sets for this command: `-c <name>=<value>`, `--config-env <name>=<envvar>`, `--config-env=<name>=<envvar>`,
 * and `-c<name>=<value>` (git rejects that spelling; it is read as config anyway, the safer reading).
 * @param {(string | undefined)[]} option an option word and its value, as lib/git-options.mjs lists them
 * @returns {string | undefined} the `name=...` text, or undefined for an option that sets no config
 */
export function configOf([word, value]) {
  if (word === '-c' || word === '--config-env') return value;
  if (word.startsWith(CONFIG_ENV_ATTACHED)) return word.slice(CONFIG_ENV_ATTACHED.length);
  return word.startsWith('-c') ? word.slice(2) : undefined;
}

/** @param {string[]} rest words after `push`; option values (`-o x`, `--repo r`) are not flags (see parsePushArgs) */
function checkGitPush(rest) {
  const { options, positional } = parsePushArgs(rest);
  // `-f`, `-fu`, `-uf`; `--force-with-lease` does not match the single-dash cluster and stays allowed
  if (options.some((f) => f === '--force' || /^-[a-zA-Z]*f/.test(f))) return destructive('force push overwrites remote history (--force-with-lease is safer)');
  if (positional.some((a) => /^\+[^\s]/.test(a))) return destructive('a +refspec push is a force push and overwrites remote history');
  if (options.includes('--mirror')) return destructive('git push --mirror overwrites the remote');
  const deletes = options.includes('--delete') || options.some((f) => /^-[a-zA-Z]*d/.test(f)) || positional.some((a) => /^:[^\s]/.test(a));
  return deletes ? destructive('deleting a remote branch or tag') : pushAsk(options);
}

/** The rules on one reading of the subcommand and its words (`commit -n`, `--no-verify`, push); undefined when none applies. */
function checkGitSubcommand({ sub, rest }) {
  const flags = flagsOf(rest);
  // -n is the short form of --no-verify for commit (also inside clusters such as -nm)
  const shortNoVerify = sub === 'commit' && flags.some((f) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f));
  const prefixNoVerify = flags.some((f) => f.length >= MIN_NO_VERIFY_PREFIX && NO_VERIFY.startsWith(f.split('=')[0]));
  if (prefixNoVerify || shortNoVerify) return `git ${NO_VERIFY} skips the git hooks`;
  return sub === 'push' ? checkGitPush(rest) : undefined;
}

/**
 * The git rules: HUSKY=0, a config that replaces the hooks or defines an alias, --no-verify, push.
 * @param {string[]} args words after `git`
 * @param {string[]} assigns `VAR=x` words before the command
 * @returns {string | undefined} the ask reason, or undefined; when git's options can be read more than one way (an option word the
 *   guard does not know), the most dangerous reading decides: a destructive reason first, else the first reason found
 */
export function checkGit(args, assigns = []) {
  if (assigns.includes('HUSKY=0')) return 'HUSKY=0 skips the git hooks';
  const { options, subcommands } = parseGitArgs(args);
  const configs = options.map(configOf);
  if (configs.some(isHooksPathConfig)) return HOOKS_PATH_REASON;
  if (configs.some(isAliasConfig)) return 'git -c alias.* defines a command for this call (an alias can run push or any shell command); write the command out';
  const reasons = subcommands.map(checkGitSubcommand).filter((reason) => reason !== undefined);
  return reasons.find((reason) => reason.startsWith(DESTRUCTIVE_PREFIX)) ?? reasons[0];
}

/** `diskutil erase*|partition*|zero*|secureErase|reformat` and `diskutil apfs delete*|erase*`. */
function diskutilWipes(args) {
  const [sub = '', second = ''] = args.filter((a) => !a.startsWith('-'));
  return DISKUTIL_WIPE.test(sub) || (/^apfs$/i.test(sub) && DISKUTIL_APFS_WIPE.test(second));
}

/** `cp x /dev/disk2`, `mv x /dev/sda`: the destination (last word) is a raw device; `tee` writes every file word. */
function deviceDestination(cmd, args) {
  const files = args.filter((a) => !a.startsWith('-') && !OUTPUT_REDIRECT.test(a));
  return (cmd === 'tee' ? files : files.slice(-1)).some((f) => RAW_DEVICE_TARGET.test(f));
}

/** Writing to a raw device or making a filesystem destroys its contents: dd of=/dev/x, mkfs/newfs, wipefs, shred or blkdiscard on a device, diskutil erase*, a redirect into a raw disk. */
export function checkDiskWipe(cmd, args) {
  const wipes = MKFS_COMMAND.test(cmd) || cmd === 'wipefs' || cmd === 'blkdiscard'
    || (cmd === 'dd' && args.some((a) => a.startsWith('of=') && DISK_DEVICE.test(a.slice(3))))
    || (cmd === 'shred' && args.some((a) => DISK_DEVICE.test(a)))
    || (cmd === 'diskutil' && diskutilWipes(args))
    || (DEVICE_WRITERS.has(cmd) && deviceDestination(cmd, args))
    || redirectTargets(args).some((t) => RAW_DEVICE_TARGET.test(t));
  return wipes ? destructive(`${cmd} can wipe a disk or device`) : undefined;
}

function redirectTargets(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    const redirect = OUTPUT_REDIRECT.exec(t); // `>| /dev/disk2`, `>&/dev/disk2` too
    if (redirect === null) return;
    const target = redirect[2] || tokens[i + 1];
    if (target) out.push(target);
  });
  return out;
}

/**
 * The advice for a hand-edited lockfile: one fixed text per name in LOCKFILES, and lib/reason-classes.mjs matches exactly these texts, so
 * no other rule's reason (whatever command text it carries) can pass for advice and skip the owner.
 * @param {string} name a LOCKFILES name
 * @returns {string} the advice text
 */
export const lockfileAdvice = (name) => `${name} is generated: let the package manager write it (pnpm install, npm install, yarn, bun install). `
  + 'To delete or move it on purpose, send the same command again and it runs.';

/** A write to a lockfile (`sed -i`, `perl -i`, mv, cp, tee, truncate, a redirect): its advice (a quality rule, not an ask), or undefined. */
export function checkLockfileEdit(cmd, args) {
  const inPlace = ['sed', 'perl'].includes(cmd) && flagsOf(args).some((f) => /^-[a-zA-Z]*i/.test(f));
  const writes = FILE_WRITERS.has(cmd) || inPlace;
  const written = cmd === 'cp' ? args.filter((a) => !a.startsWith('-')).slice(-1) : args;
  const touched = [...(writes ? written : []), ...redirectTargets(args)].find(isLockfile);
  return touched === undefined ? undefined : lockfileAdvice(basenameOf(touched));
}

/**
 * A command word that is an unknown variable (`$RM -rf /x`) hides what runs. It asks only when the words also look like a
 * forced recursive delete (an `r` flag and an `f` flag), so `$EDITOR file` and `$COMPOSE up` stay silent.
 */
export function checkHiddenRm(cmd, args) {
  if (!cmd.startsWith('$')) return undefined;
  const letters = flagsOf(args).filter((f) => !f.startsWith('--')).join('').replace(/-/g, '');
  const recursiveForce = /[rR]/.test(letters) && /f/.test(letters);
  return recursiveForce ? destructive(`${cmd} with -rf flags hides the command (rm?); write the command name out`) : undefined;
}

const STDIN_RUNNERS = new Set(['xargs', 'parallel']);
const PARALLEL_INPUTS = /^:{3,4}\+?$/; // `parallel cmd ::: a b`: the words after it are inputs, not the command
const isRecursiveRm = (args) => flagsOf(args).some((flag) => RECURSIVE_FLAG.test(flag));
const stdinRmReason = (runner) => destructive(`${runner} runs rm -r on paths read from stdin; the guard cannot check those targets`);

/** The command parallel runs: its words up to the first `:::` input list, split on blanks like the shell line parallel builds (`'rm -rf {}'`). */
function parallelCommand(args) {
  const end = args.findIndex((word) => PARALLEL_INPUTS.test(word));
  return (end === -1 ? args : args.slice(0, end)).flatMap((word) => word.split(/\s+/)).filter(Boolean);
}

/**
 * `find . | xargs rm -rf`, `ls | parallel 'rm -r {}'`: a recursive rm whose targets xargs or parallel read from stdin. The rm path rule only
 * sees the words written in the command (none, or a `{}` placeholder), so without this rule such a delete passes silently.
 * @param {string} cmd the command being checked
 * @param {string[]} args its words
 * @param {string[]} before the words before it in the same simple command: wrappers (sudo, xargs, parallel) and their options
 * @returns {string | undefined} a destructive ask reason, or undefined (a non-recursive `xargs rm -f` stays silent)
 */
export function checkStdinRm(cmd, args, before = []) {
  if (cmd === 'parallel') {
    const words = parallelCommand(args);
    const rmAt = words.findIndex((word) => commandName(word) === 'rm');
    return rmAt !== -1 && isRecursiveRm(words.slice(rmAt + 1)) ? stdinRmReason('parallel') : undefined;
  }
  if (cmd !== 'rm' || !isRecursiveRm(args)) return undefined;
  const runner = stdinRunnerOf(before);
  return runner === undefined ? undefined : stdinRmReason(runner);
}

/** The stdin runner (xargs, parallel) among the words before a command, unless a `:::` input list ends the runner's command first. */
function stdinRunnerOf(before) {
  const runnerAt = before.findLastIndex((word) => STDIN_RUNNERS.has(commandName(word)));
  if (runnerAt === -1 || before.slice(runnerAt + 1).some((word) => PARALLEL_INPUTS.test(word))) return undefined;
  return commandName(before[runnerAt]);
}

/**
 * `xargs sh -c 'rm -rf "$@"' _`, `xargs -I{} bash -c 'rm -r {}'`: the `-c` script of a shell that xargs or parallel runs deletes recursively,
 * and its targets come from stdin too. The script is still checked as a command line of its own.
 * @param {string} script the `-c` script of the shell
 * @param {string[]} before the words before the shell in its simple command: wrappers, xargs and its options
 * @returns {string | undefined} a destructive ask reason, or undefined
 */
export function checkStdinScriptRm(script, before = []) {
  const runner = stdinRunnerOf(before);
  if (runner === undefined) return undefined;
  const removes = segments(script).some((words) => {
    const { cmd, args } = commandOf(words);
    return cmd === 'rm' && isRecursiveRm(args);
  });
  return removes ? stdinRmReason(runner) : undefined;
}

const SECRET_PRINT = 'prints a stored secret into the transcript; confirm it';
const KEYCHAIN_PASSWORD_LOOKUP = /^find-(?:generic|internet)-password$/;
const KEYCHAIN_DUMPS = new Set(['dump-keychain', 'export']);
// options of find-generic-password / find-internet-password that take a value (the rest of the cluster, or the next word)
const LOOKUP_VALUE_LETTERS = new Set(['a', 'c', 'C', 'd', 'D', 'G', 'j', 'l', 'p', 'P', 'r', 's', 't']);
const PASSWORD_PRINT_LETTERS = new Set(['g', 'w']); // -g prints the password with the attributes, -w prints only the password

/** One option cluster read like getopt: 'prints' (-g / -w), 'value' (the next word is an option value) or 'flags'. */
function readLookupCluster(word) {
  for (let at = 1; at < word.length; at++) {
    if (PASSWORD_PRINT_LETTERS.has(word[at])) return 'prints';
    if (LOOKUP_VALUE_LETTERS.has(word[at])) return at === word.length - 1 ? 'value' : 'flags'; // `-sgithub`: the rest is the value
  }
  return 'flags';
}

/** True when the options of a find-*-password call ask for the password itself (`-w`, `-g`, `-ga me`; not a `-s` value). */
function printsPassword(args) {
  for (let i = 0; i < args.length; i++) {
    const kind = /^-[A-Za-z]/.test(args[i]) ? readLookupCluster(args[i]) : 'flags';
    if (kind === 'prints') return true;
    if (kind === 'value') i++;
  }
  return false;
}

/**
 * `security find-generic-password|find-internet-password` with `-w` or `-g`, `security dump-keychain`, `security export`: the stored secret
 * is printed into the transcript (also when a `$(...)` captures it: the guard cannot tell). An attribute-only lookup stays silent.
 * A read of the account tool's own service (`-s claude-setup-account`, lib/account-reads.mjs) runs with no ask.
 * @param {string} cmd the command name
 * @param {string[]} args its words
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkKeychainPrint(cmd, args) {
  if (cmd !== 'security') return undefined;
  let i = 0;
  while (args[i]?.startsWith('-')) i += args[i] === '-p' ? 2 : 1; // `security -q ...`, `security -p prompt ...`
  const [sub = '', ...rest] = args.slice(i);
  const prints = KEYCHAIN_DUMPS.has(sub) || (KEYCHAIN_PASSWORD_LOOKUP.test(sub) && printsPassword(rest));
  if (prints && isAccountTokenRead(sub, rest)) return undefined; // the account tool's own service: the owner allows its token reads (lib/account-reads.mjs)
  return prints ? `security ${sub} ${SECRET_PRINT}` : undefined;
}

const GH_KEY_VALUE_OPTIONS = new Set(['-t', '--title', '--type']); // `gh ssh-key add` options that take the next word
const STDIN_FROM = /^0?<$/; // `gh ssh-key add < key`: the key comes on stdin from the next word

/** The key file of `gh ssh-key add [flags] <path>` (or `< path`): the first word after `add` that is no option, option value or output redirection. */
function keyFileOf(args) {
  for (let i = 2; i < args.length; i++) {
    const word = args[i];
    if (STDIN_FROM.test(word)) return args[i + 1];
    const output = OUTPUT_REDIRECT.exec(word); // `> f`, `>| f`: the target is the next word; `2>&1`, `>out`: this one
    if (GH_KEY_VALUE_OPTIONS.has(word) || output?.[2] === '') i++;
    else if (!word.startsWith('-') && output === null) return word.replace(/^0?</, '');
  }
  return undefined;
}

/**
 * `gh auth token` prints the stored GitHub token, like a keychain read; `gh ssh-key add <path>` uploads the file to the account, and a file
 * that is not a public `*.pub` key may be the private key.
 * @param {string} cmd the command name
 * @param {string[]} args its words
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkGhSecret(cmd, args) {
  if (cmd !== 'gh') return undefined;
  const keyFile = args[0] === 'ssh-key' && args[1] === 'add' ? keyFileOf(args) : undefined;
  if (keyFile !== undefined && !keyFile.endsWith('.pub')) return 'gh ssh-key add uploads a key file that is not a .pub public key; confirm it';
  return tokenPrint(cmd, args);
}

const tokenPrint = (cmd, args) => (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token' ? `gh auth token ${SECRET_PRINT}` : undefined);

/** The secret-print ask of one command (a keychain read or `gh auth token`), or undefined; lib/captured-read.mjs uses it. */
export const secretPrintOf = (cmd, args) => checkKeychainPrint(cmd, args) ?? tokenPrint(cmd, args);
/** True for the ask reason of a secret print, also with a suffix such as "(matched in raw text)". */
export const isSecretPrintReason = (reason) => reason.includes(SECRET_PRINT);
