// Per-command rules of pre-bash-guard that need only one command's name and words: git, disk wipes, lockfile hand edits,
// a variable used as the command name with rm-style flags, rm -r run by xargs or parallel, and printing a stored keychain secret.
// Exports: checkGit(args, assigns), checkDiskWipe(cmd, args), checkLockfileEdit(cmd, args), checkHiddenRm(cmd, args),
// checkStdinRm(cmd, args, before), checkKeychainPrint(cmd, args) - each returns an ask reason, or undefined when the command is fine.
// Pure, no I/O. Every rule is an ask (the hook shows a timed dialog); a destructive one starts with "DESTRUCTIVE: ".
import { commandName } from './command-of.mjs';
import { parsePushArgs, pushAsk } from './outward.mjs';
import { RECURSIVE_FLAG } from './rm-paths.mjs';
import { basenameOf, flagsOf } from './shell-words.mjs';
import { destructive } from './verdict.mjs';

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);
// rm is allowed on lockfiles (delete and reinstall is a normal fix); cp only writes its last argument.
const FILE_WRITERS = new Set(['mv', 'cp', 'tee', 'truncate']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const REDIRECT = /^(\d?>>?|&>>?)/;
const NO_VERIFY = '--no-verify';
const MIN_NO_VERIFY_PREFIX = 8; // `--no-ver`: git accepts any unique prefix of a long option
const DISK_DEVICE = /^\/dev\/(?!null$|zero$|tty|std|fd\/|pts\/)/;
const MKFS_COMMAND = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?)$/; // mkfs.ext4, newfs_hfs
const DISKUTIL_WIPE = /^(?:erase|partition|zero|secureerase|reformat|apfs(?:delete|erase))/i;
const DISKUTIL_APFS_WIPE = /^(?:delete|erase)/i; // `diskutil apfs deleteContainer`, `apfs eraseVolume`
const DEVICE_WRITERS = new Set(['cp', 'mv', 'install', 'tee']); // diskutil eraseDisk, partitionDisk, zeroDisk, secureErase, reformat
const RAW_DEVICE_TARGET = /^\/dev\/(?:r?disk|sd|hd|nvme|vd|xvd|mmcblk)/; // `> /dev/disk2`, `>/dev/sda`
const isHooksPathConfig = (value = '') => /^core\.hookspath=/i.test(value);
const isLockfile = (p) => LOCKFILES.has(basenameOf(p));

/** `git -c core.hooksPath=x` / `--config-env=core.hooksPath=x` replace the repo hooks for one command. */
function usesHooksPathOverride(words) {
  for (let i = 0; words[i]?.startsWith('-'); i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1) {
    const opt = words[i];
    const config = opt === '-c' ? words[i + 1] : opt.startsWith('-c') ? opt.slice(2) : opt.replace(/^--config-env=/, '');
    if (isHooksPathConfig(config)) return true;
  }
  return false;
}

/** `git -c alias.p=push p`, `git -c 'alias.x=!git push' x`: the alias hides what runs. */
function definesAlias(words) {
  for (let i = 0; words[i]?.startsWith('-'); i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1) {
    const config = words[i] === '-c' ? words[i + 1] : words[i].startsWith('-c') ? words[i].slice(2) : undefined;
    if (/^alias\./i.test(config ?? '')) return true;
  }
  return false;
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

/** @param {string[]} args words after `git`; @param {string[]} assigns `VAR=x` words before the command */
export function checkGit(args, assigns = []) {
  if (assigns.includes('HUSKY=0')) return 'HUSKY=0 skips the git hooks';
  if (usesHooksPathOverride(args)) return 'git -c core.hooksPath bypasses the git hooks';
  if (definesAlias(args)) return 'git -c alias.* defines a command for this call (an alias can run push or any shell command); write the command out';
  const words = [...args];
  while (words[0]?.startsWith('-')) words.splice(0, GIT_VALUE_OPTIONS.has(words[0]) ? 2 : 1); // `git -C dir commit -n`
  const [sub, ...rest] = words;
  const flags = flagsOf(rest);
  // -n is the short form of --no-verify for commit (also inside clusters such as -nm)
  const shortNoVerify = sub === 'commit' && flags.some((f) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f));
  const prefixNoVerify = flags.some((f) => f.length >= MIN_NO_VERIFY_PREFIX && NO_VERIFY.startsWith(f.split('=')[0]));
  if (prefixNoVerify || shortNoVerify) return `git ${NO_VERIFY} skips the git hooks`;
  return sub === 'push' ? checkGitPush(rest) : undefined;
}

/** `diskutil erase*|partition*|zero*|secureErase|reformat` and `diskutil apfs delete*|erase*`. */
function diskutilWipes(args) {
  const [sub = '', second = ''] = args.filter((a) => !a.startsWith('-'));
  return DISKUTIL_WIPE.test(sub) || (/^apfs$/i.test(sub) && DISKUTIL_APFS_WIPE.test(second));
}

/** `cp x /dev/disk2`, `mv x /dev/sda`: the destination (last word) is a raw device; `tee` writes every file word. */
function deviceDestination(cmd, args) {
  const files = args.filter((a) => !a.startsWith('-') && !REDIRECT.test(a));
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
    if (!REDIRECT.test(t)) return;
    const target = t.replace(REDIRECT, '') || tokens[i + 1];
    if (target) out.push(target);
  });
  return out;
}

export function checkLockfileEdit(cmd, args) {
  const inPlace = ['sed', 'perl'].includes(cmd) && flagsOf(args).some((f) => /^-[a-zA-Z]*i/.test(f));
  const writes = FILE_WRITERS.has(cmd) || inPlace;
  const written = cmd === 'cp' ? args.filter((a) => !a.startsWith('-')).slice(-1) : args;
  const touched = [...(writes ? written : []), ...redirectTargets(args)].find(isLockfile);
  return touched === undefined ? undefined : `${basenameOf(touched)} is generated; the package manager should write it, not a hand edit`;
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
  const runnerAt = before.findLastIndex((word) => STDIN_RUNNERS.has(commandName(word)));
  if (runnerAt === -1 || before.slice(runnerAt + 1).some((word) => PARALLEL_INPUTS.test(word))) return undefined;
  return stdinRmReason(commandName(before[runnerAt]));
}

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
  return prints ? `security ${sub} prints a stored secret into the transcript; confirm it` : undefined;
}
