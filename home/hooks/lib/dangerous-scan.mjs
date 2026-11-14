// Command-position-independent scan: finds a dangerous command behind a wrapper that no list knows (`ionice -c3 rm -rf /x`,
// `caffeinate -i git push`, `chrt 10 dd of=/dev/sda`) by trying every later word of a simple command as the start of a command.
// Exports: scanWrapped(words, parsed, check) -> string[] reasons; SCAN_VERBS; SCAN_STOP.
// Only the verbs of the rule set are tried (rm, git, dd, mkfs*, wipefs, blkdiscard, shred, gh, package managers, ssh/scp/rsync,
// psql/mysql, shells), and only after the real command word, so `rm -rf node_modules` and `git status` are unaffected.
// A scan is skipped when the real command only displays or forwards words (SCAN_STOP): `echo rm -rf /`, `grep git push`,
// `man rm`, `git rm -r x`, `docker run img rm -rf /`, `ssh host rm -rf /` (that rm is not local) must stay silent. The package runners
// `pnpm exec|dlx`, `yarn exec|dlx`, `npm exec`, `bun x` and `npx` are the exception: what follows them runs, so it is scanned.
// Pure, no I/O. Invariant: a false positive costs the owner a dialog, so when in doubt the verb is not on the list.
import { commandName } from './command-of.mjs';

/** Verbs whose rules are worth a scan: the destructive ones, outward actions, remote writes, nested shells. */
export const SCAN_VERBS = new Set(['rm', 'git', 'dd', 'wipefs', 'blkdiscard', 'shred', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'lerna', 'npx',
  'diskutil', 'ssh', 'scp', 'rsync', 'psql', 'mysql', 'bash', 'sh', 'zsh', 'ksh', 'dash']);
// a wrapper's own words are few; the cap keeps the scan linear-ish on a huge file list (each hit re-reads the words after it)
const MAX_SCAN_WORDS = 100;
const MKFS_VERB = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?)$/;
// commands that print, search or forward their words, or run them somewhere else (container, remote host, package script)
export const SCAN_STOP = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'man', 'which', 'type', 'whereis', 'whatis', 'apropos',
  'help', 'cat', 'head', 'tail', 'less', 'more', 'bat', 'diff', 'cmp', 'wc', 'sort', 'uniq', 'tr', 'cut', 'test', '[', '[[', 'true', 'false', 'alias',
  'unalias', 'read', 'set', 'unset', 'export', 'declare', 'local', 'readonly', 'typeset', 'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'lerna',
  'cargo', 'go', 'pip', 'pip3', 'uv', 'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'ssh', 'scp', 'rsync', 'sftp', 'psql', 'mysql', 'bash', 'sh',
  'zsh', 'ksh', 'dash']);

// package runners that execute another command (`pnpm exec rm -rf /`, `npx git push`): unlike `pnpm run x` (a package script), their words ARE a command
const RUNNER_WORDS = new Map([['pnpm', ['exec', 'dlx']], ['yarn', ['exec', 'dlx']], ['npm', ['exec', 'x']], ['bun', ['x']], ['npx', null]]);
const runsCommand = (cmd, args) => RUNNER_WORDS.has(cmd) && (RUNNER_WORDS.get(cmd) === null || args.some((a) => RUNNER_WORDS.get(cmd).includes(a)));

const isVerbWord = (word) => !word.startsWith('-') && !word.includes('=') && !word.includes('$') && (SCAN_VERBS.has(commandName(word)) || MKFS_VERB.test(commandName(word)));

/**
 * @param {string[]} words normalised words of one simple command (variables substituted, ANSI-C decoded)
 * @param {{cmd: string|undefined, at: number}} parsed the command commandOf found and the index of its word
 * @param {(cmd: string, args: string[], at: number) => string[]} check the guard's rules for one command (`at`: index of its word in `words`); returns ask reasons
 * @returns {string[]} reasons for dangerous commands found after the real command word
 */
export function scanWrapped(words, parsed, check) {
  if (parsed.cmd === undefined || parsed.cmd.startsWith('#') || (SCAN_STOP.has(parsed.cmd) && !runsCommand(parsed.cmd, parsed.args))) return [];
  const reasons = [];
  for (let i = parsed.at + 1; i < Math.min(words.length, parsed.at + 1 + MAX_SCAN_WORDS); i++) {
    if (words[i].startsWith('#')) break; // a comment: the rest of the line is text
    if (isVerbWord(words[i])) reasons.push(...check(commandName(words[i]), words.slice(i + 1), i));
  }
  return reasons;
}
