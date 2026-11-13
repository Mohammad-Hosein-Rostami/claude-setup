// Per-command rules of pre-bash-guard that need only one command's name and words: git, disk wipes, lockfile hand edits,
// and a variable used as the command name with rm-style flags.
// Exports: checkGit(args, assigns), checkDiskWipe(cmd, args), checkLockfileEdit(cmd, args), checkHiddenRm(cmd, args)
// - each returns an ask reason, or undefined when the command is fine.
// Pure, no I/O. Every rule is an ask (the hook shows a timed dialog); a destructive one starts with "DESTRUCTIVE: ".
import { parsePushArgs, pushAsk } from './outward.mjs';
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
const MKFS_COMMAND = /^mkfs(\.\w+)?$/;
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

/** Writing to a raw device or making a filesystem destroys its contents: dd of=/dev/x, mkfs, wipefs, shred or blkdiscard on a device. */
export function checkDiskWipe(cmd, args) {
  const wipes = MKFS_COMMAND.test(cmd) || cmd === 'wipefs' || cmd === 'blkdiscard'
    || (cmd === 'dd' && args.some((a) => a.startsWith('of=') && DISK_DEVICE.test(a.slice(3))))
    || (cmd === 'shred' && args.some((a) => DISK_DEVICE.test(a)));
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
