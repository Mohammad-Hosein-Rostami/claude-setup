// Segment tokens -> the real command: looks through keywords (`if`, `!`, `{`), `VAR=x` words and wrappers (sudo, env, ...).
// Exports: commandOf(tokens) -> {cmd, args, assigns}; commandName(word); KEYWORDS.
// Pure, no I/O. Shared by pre-bash-guard and the remote-command classifier (lib/remote.mjs).
import { basenameOf } from './shell-words.mjs';

export const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until']);
// wrapper -> options that consume the next token as their value
const WRAPPERS = new Map([
  ['command', new Set()], ['builtin', new Set()], ['nohup', new Set()], ['exec', new Set()], ['time', new Set()],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'])], ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C'])], ['nice', new Set(['-n'])], ['timeout', new Set(['-s', '-k'])],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])], ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['sshpass', new Set(['-f', '-d', '-P'])],
]);
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const ASSIGNMENT = /^\w+=/;

/** Command word -> bare name: `/bin/rm`, `\rm` and `rm.exe` all become `rm` (lowercased on Windows). */
export function commandName(word) {
  const name = basenameOf(word).replace(/\.exe$/i, '');
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/** Index of the first word after a wrapper's own options (`sudo -u me`, `timeout -s KILL 5`, `--`). */
function skipWrapperOptions(tokens, start, valueOptions, isTimeout) {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') return i + 1;
    if (t.startsWith('-') && t.length > 1) i += valueOptions.has(t) ? 2 : 1;
    else if (isTimeout && DURATION.test(t)) i += 1;
    else break;
  }
  return i;
}

/**
 * Segment tokens -> the real command, its arguments and the `VAR=x` words before it, looking through keywords and wrappers.
 * @param {string[]} tokens unquoted words of one segment
 * @returns {{cmd: string|undefined, args: string[], assigns: string[]}} cmd undefined for an assignment-only segment
 */
export function commandOf(tokens) {
  const assigns = [];
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i];
    const name = commandName(word);
    if (ASSIGNMENT.test(word)) assigns.push(word);
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word)) i += 1;
    else if (WRAPPERS.has(name)) i = skipWrapperOptions(tokens, i + 1, WRAPPERS.get(name), name === 'timeout');
    else return { cmd: name, args: tokens.slice(i + 1), assigns };
  }
  return { cmd: undefined, args: [], assigns };
}
