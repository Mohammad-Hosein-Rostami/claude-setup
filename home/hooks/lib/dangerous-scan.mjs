// Command-position-independent scan: finds a dangerous command behind a wrapper that no list knows (`ionice -c3 rm -rf /x`,
// `caffeinate -i git push`, `chrt 10 dd of=/dev/sda`) by trying every later word of a simple command as the start of a command.
// Exports: scanWrapped(words, parsed, check) -> string[] reasons; SCAN_VERBS; SCAN_STOP; runsCommand(cmd, args), runsBin(cmd, args, names),
// packageName(word) (lib/claude-starts.mjs reads runners the same way).
// Only the verbs of the rule set are tried (rm, git, dd, mkfs*, wipefs, blkdiscard, shred, gh, glab, hub, tea, package managers, ssh/scp/rsync,
// psql/mysql, shells, the deploy tools of lib/deploy.mjs), and only after the real command word, so `rm -rf node_modules` and `git status`
// are unaffected. `vercel` deploys with no words at all, so it is tried only where a package runner runs it (`npx vercel`): a folder
// named vercel (`mkdir vercel`) must not ask.
// A scan is skipped when the real command only displays or forwards words (SCAN_STOP): `echo rm -rf /`, `grep git push`,
// `man rm`, `git rm -r x`, `docker run img rm -rf /`, `ssh host rm -rf /` (that rm is not local) must stay silent. The package runners
// `pnpm exec|dlx`, `yarn exec|dlx`, `npm exec`, `bun x`, `bunx`, `pnpx` and `npx` are the exception: what follows them runs, so it is scanned;
// so is `yarn|pnpm|bun <deploy tool>`, which runs the package's own bin. A runner anywhere in the words (`caffeinate npx vercel --prod`)
// counts for the words after it, and a package word after a runner is read without its version (`npx vercel@latest`).
// git's own programs (`git-push`) are the git verb (lib/command-of.mjs asGitSubcommand); the stop list reads the name as written, so after
// `git-foo` (a program the guard does not know) the scan runs as after any unknown command.
// Pure, no I/O. Invariant: a false positive costs the owner a dialog, so when in doubt the verb is not on the list.
import { asGitSubcommand, commandName } from './command-of.mjs';
import { DEPLOY_TOOLS } from './deploy.mjs';

// deploy tools whose bare name already deploys: tried only right where a package runner runs its words (see the header)
const RUNNER_ONLY_VERBS = new Set(['vercel']);

/** Verbs whose rules are worth a scan: the destructive ones, outward actions, remote writes, nested shells. */
export const SCAN_VERBS = new Set(['rm', 'git', 'dd', 'wipefs', 'blkdiscard', 'shred', 'gh', 'glab', 'hub', 'tea', 'npm', 'pnpm', 'yarn', 'bun', 'lerna', 'npx',
  'diskutil', 'ssh', 'scp', 'rsync', 'psql', 'mysql', 'bash', 'sh', 'zsh', 'ksh', 'dash', ...DEPLOY_TOOLS.filter((tool) => !RUNNER_ONLY_VERBS.has(tool))]);
// a wrapper's own words are few; the cap keeps the scan linear-ish on a huge file list (each hit re-reads the words after it)
const MAX_SCAN_WORDS = 100;
const MKFS_VERB = /^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?)$/;
// commands that print, search or forward their words, or run them somewhere else (container, remote host, package script)
export const SCAN_STOP = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'man', 'which', 'type', 'whereis', 'whatis', 'apropos',
  'help', 'cat', 'head', 'tail', 'less', 'more', 'bat', 'diff', 'cmp', 'wc', 'sort', 'uniq', 'tr', 'cut', 'test', '[', '[[', 'true', 'false', 'alias',
  'unalias', 'read', 'set', 'unset', 'export', 'declare', 'local', 'readonly', 'typeset', 'git', 'gh', 'glab', 'hub', 'tea', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'lerna',
  'cargo', 'go', 'pip', 'pip3', 'uv', 'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'ssh', 'scp', 'rsync', 'sftp', 'psql', 'mysql', 'bash', 'sh',
  'zsh', 'ksh', 'dash']);

// package runners that execute another command (`pnpm exec rm -rf /`, `npx git push`): unlike `pnpm run x` (a package script), their words ARE a command
const RUNNER_WORDS = new Map([['pnpm', ['exec', 'dlx']], ['yarn', ['exec', 'dlx']], ['npm', ['exec', 'x']], ['bun', ['x']], ['npx', null], ['bunx', null], ['pnpx', null]]);
/** True when a package runner runs the command in its words (`npx x`, `pnpm dlx x`; not `pnpm run x`, a package script). */
export const runsCommand = (cmd, args) => RUNNER_WORDS.has(cmd) && (RUNNER_WORDS.get(cmd) === null || args.some((a) => RUNNER_WORDS.get(cmd).includes(a)));

const PACKAGE_VERSION = /(?<=[^@/])@[^@/]*$/; // `vercel@latest`, `@scope/pkg@2`; the scope's own `@` stays
/** A package word without its version: `vercel@latest` is `vercel`. */
export const packageName = (word) => word.replace(PACKAGE_VERSION, '');

const BIN_RUNNERS = new Set(['yarn', 'pnpm', 'bun']); // `yarn wrangler deploy` runs the bin of the package named first
const DEPLOY_TOOL_NAMES = new Set(DEPLOY_TOOLS);
/**
 * @param {string} cmd the command name
 * @param {string[]} args its words
 * @param {Set<string>} names the bins that matter to the caller (deploy tools, `claude`)
 * @returns {boolean} true when yarn, pnpm or bun runs a bin of `names` by its name (its first word that is no option)
 */
export function runsBin(cmd, args, names) {
  const first = args.find((word) => !word.startsWith('-'));
  return BIN_RUNNERS.has(cmd) && first !== undefined && names.has(commandName(packageName(first)));
}

/** The command a word starts, as the guard's rules name it: its basename, `git` for `git-<sub>` (args: `<sub>` and the words after it). */
const commandAt = (words, i, afterRunner) =>
  asGitSubcommand({ cmd: commandName(afterRunner ? packageName(words[i]) : words[i]), args: words.slice(i + 1) });
const isVerbWord = (word, afterRunner) => !word.startsWith('-') && !word.includes('=') && !word.includes('$')
  && (SCAN_VERBS.has(commandAt([word], 0, afterRunner).cmd) || MKFS_VERB.test(commandName(word))
    || (afterRunner && RUNNER_ONLY_VERBS.has(commandAt([word], 0, true).cmd)));
const startsRunner = ({ cmd, args }) => cmd !== undefined && (runsCommand(cmd, args) || runsBin(cmd, args, DEPLOY_TOOL_NAMES));

/**
 * @param {string[]} words normalised words of one simple command (variables substituted, ANSI-C decoded)
 * @param {{cmd: string|undefined, at: number}} parsed the command commandOf found and the index of its word
 * @param {(cmd: string, args: string[], at: number) => string[]} check the guard's rules for one command (`at`: index of its word in `words`); returns ask reasons
 * @returns {string[]} reasons for dangerous commands found after the real command word
 */
export function scanWrapped(words, parsed, check) {
  const written = commandName(words[parsed.at] ?? '');
  let afterRunner = startsRunner(parsed);
  if (parsed.cmd === undefined || parsed.cmd.startsWith('#') || (SCAN_STOP.has(written) && !afterRunner)) return [];
  const reasons = [];
  for (let i = parsed.at + 1; i < Math.min(words.length, parsed.at + 1 + MAX_SCAN_WORDS); i++) {
    if (words[i].startsWith('#')) break; // a comment: the rest of the line is text
    const command = commandAt(words, i, afterRunner);
    if (isVerbWord(words[i], afterRunner)) reasons.push(...check(command.cmd, command.args, i));
    afterRunner ||= startsRunner(command); // `caffeinate bunx vercel`: the runner's words run
  }
  return reasons;
}
