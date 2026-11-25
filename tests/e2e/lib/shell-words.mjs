// Reads what a Bash command line runs and writes, for the E6 checks. Exports: runsPushOrDeploy(command), writtenPaths(calls, cwd).
// Why (review round 2, R1 and R2): a regex on the whole line missed `/abs/deploy.sh`, `"$PWD/deploy.sh"`, `bash -c "git push"`,
// `git -c k=v push`, `env X=1 git push` and `command git push`, while a grep or cat of the README names both and runs neither.
// So each segment (split at ; & | ( ) { } ` and newlines) is read word by word: wrappers (env, command, exec, eval, a shell
// with its flags, VAR=value) are skipped, and the first real word decides: a path whose last part is deploy.sh, or git
// (with its global options) whose subcommand is push. A commands file counts only when max wrote it: a Write or Edit call's
// path, or the target of a `>`, `>>` or `tee` in its Bash.
// Invariants: reads strings only, runs nothing; quotes are dropped, not parsed, so a quoted `-c` string is read as words.
import { isAbsolute, join } from 'node:path';

const SEPARATORS = /[;&|\n(){}`]/;
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'eval', 'nohup', 'time', 'sudo', 'xargs', 'then', 'do', 'else', '!']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** git's global options that take the next word as their value (`git -C dir push`, `git -c k=v push`). */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const REDIRECT = /(?:>>?|\btee(?:\s+-a)?)\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)/g;

const word = (token) => token.replace(/["']/g, '');
const lastPart = (token) => token.split('/').pop();

/** @returns {boolean} the segment's command is deploy.sh or a git push */
function segmentRuns(segment) {
  const words = segment.trim().split(/\s+/).map(word).filter(Boolean);
  let at = 0;
  while (at < words.length && (WRAPPERS.has(words[at]) || ASSIGNMENT.test(words[at]) || words[at].startsWith('-') || SHELLS.has(lastPart(words[at])))) at += 1;
  const head = words[at];
  if (head === undefined) return false;
  if (lastPart(head) === 'deploy.sh') return true;
  if (lastPart(head) !== 'git') return false;
  let sub = at + 1;
  while (words[sub]?.startsWith('-')) sub += GIT_VALUE_OPTIONS.has(words[sub]) ? 2 : 1;
  return words[sub] === 'push';
}

/** @returns {boolean} some segment of the command line runs deploy.sh or a git push */
export const runsPushOrDeploy = (command) => String(command).split(SEPARATORS).some(segmentRuns);

/**
 * @param {{name: string, input: object}[]} calls one agent's tool calls (transcripts.mjs toolCalls)
 * @param {string} cwd the folder a relative path is read against
 * @returns {string[]} the paths the calls wrote: Write and Edit paths, and Bash `>`, `>>` and `tee` targets
 */
export function writtenPaths(calls, cwd) {
  const paths = [];
  for (const call of calls) {
    if (WRITE_TOOLS.has(call.name) && typeof call.input.file_path === 'string') paths.push(call.input.file_path);
    if (call.name === 'Bash') for (const match of String(call.input.command ?? '').matchAll(REDIRECT)) paths.push(word(match[1]));
  }
  return [...new Set(paths.filter((path) => !path.startsWith('/dev/')).map((path) => (isAbsolute(path) ? path : join(cwd, path))))];
}
