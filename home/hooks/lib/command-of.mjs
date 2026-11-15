// Segment tokens -> the real command: looks through keywords (`if`, `!`, `{`), `VAR=x` words and wrappers (sudo, env, ...).
// Exports: commandOf(tokens) -> {cmd, args, assigns, at (index of the command word)}; commandName(word); KEYWORDS;
// asGitSubcommand(command): git's own programs (`git-push`, `<exec path>/git-rebase`) read as `git <sub>`.
// Pure, no I/O. Shared by pre-bash-guard and the remote-command classifier (lib/remote.mjs).
import { basenameOf } from './shell-words.mjs';

export const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until']);
// wrapper -> options that consume the next token as their value (`sudo --user root`, `exec -a name`, `sshpass -p X`); the
// attached forms (`--user=root`, `-uroot`) need no entry because they are a single token.
const WRAPPERS = new Map([
  ['command', new Set()], ['builtin', new Set()], ['nohup', new Set()], ['exec', new Set(['-a'])], ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-R', '-T', '--user', '--group', '--close-from', '--host', '--prompt', '--role', '--type',
    '--other-user', '--chdir', '--chroot', '--command-timeout'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])], ['nice', new Set(['-n', '--adjustment'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['sshpass', new Set(['-f', '-d', '-P', '-p'])],
]);
// `command -v x` / `command -V x` only looks a name up (prints its path); nothing runs, so it is not a wrapper there
const LOOKUP_OPTION = /^-p?[vV][pvV]*$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const ASSIGNMENT = /^\w+=/;
// git runs subcommand <sub> as the program `git-<sub>` from its exec path (also for external ones such as git-lfs); git matches it as written
const GIT_PROGRAM = /^git-([A-Za-z0-9][A-Za-z0-9-]*)$/;

/** Command word -> bare name: `/bin/rm`, `\rm` and `rm.exe` all become `rm` (lowercased on Windows). */
export function commandName(word) {
  const name = basenameOf(word).replace(/\.exe$/i, '');
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/** True when the option word takes the next token as its value: listed itself, or a short cluster ending in such an option (`-Eu`). */
const takesValue = (word, valueOptions) => valueOptions.has(word) || (/^-[A-Za-z]{2,}$/.test(word) && valueOptions.has(`-${word.slice(-1)}`));

/** Index of the first word after a wrapper's own options (`sudo -u me`, `timeout -s KILL 5`, `--`). */
function skipWrapperOptions(tokens, start, valueOptions, isTimeout) {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') return i + 1;
    if (t.startsWith('-') && t.length > 1) i += takesValue(t, valueOptions) ? 2 : 1;
    else if (isTimeout && DURATION.test(t)) i += 1;
    else break;
  }
  return i;
}

/**
 * Segment tokens -> the real command, its arguments and the `VAR=x` words before it, looking through keywords and wrappers.
 * @param {string[]} tokens unquoted words of one segment
 * @returns {{cmd: string|undefined, args: string[], assigns: string[], at: number}} cmd undefined for an assignment-only segment
 */
export function commandOf(tokens) {
  const assigns = [];
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i];
    const name = commandName(word);
    if (ASSIGNMENT.test(word)) assigns.push(word);
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word)) i += 1;
    else if (name === 'command' && LOOKUP_OPTION.test(tokens[i + 1] ?? '')) return { cmd: name, args: tokens.slice(i + 1), assigns, at: i };
    else if (WRAPPERS.has(name)) i = skipWrapperOptions(tokens, i + 1, WRAPPERS.get(name), name === 'timeout');
    else return { cmd: name, args: tokens.slice(i + 1), assigns, at: i };
  }
  return { cmd: undefined, args: [], assigns, at: tokens.length };
}

/**
 * A command whose name is `git-<sub>` (after commandName: any directory, a leading `\`, `.exe`) as the git command it is: `git <sub> <args>`, so every
 * git check reads it. git-lfs, git-tidy and other programs that only share the prefix become `git lfs ...`, which git runs the same way.
 * @param {{cmd: string|undefined, args: string[]}} command a command as commandOf returns it (other fields are kept)
 * @returns {typeof command} the same command, or a copy with cmd `git` and `<sub>` in front of args
 */
export function asGitSubcommand(command) {
  const sub = GIT_PROGRAM.exec(command.cmd ?? '')?.[1];
  return sub === undefined ? command : { ...command, cmd: 'git', args: [sub, ...command.args] };
}
