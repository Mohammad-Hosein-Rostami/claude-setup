// Whether a Bash command only reads, for agent-budget.mjs: the lead keeps git and reading commands at any context size.
// Exports: isReadOnlyCommand(command). Pure, no I/O; the shell text is split by lib/shell-words.mjs, never run.
import { commandOf } from './command-of.mjs';
import { OUTPUT_REDIRECT, segments } from './shell-words.mjs';

// Commands the lead may keep running at any context size (git: every subcommand). sed and find count only without their writing options.
const READ_ONLY_COMMANDS = new Set(['git', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'echo', 'printf', 'which', 'type', 'stat',
  'file', 'diff', 'date', 'du', 'df', 'tree', 'jq', 'sort', 'uniq', 'cut', 'basename', 'dirname', 'realpath', 'cd', 'true', 'sed', 'find']);
const WRITING_OPTION = { sed: /^(?:-[^-]*i|--in-place)/, find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/ };
const HARMLESS_TARGET = /^(?:&\d|\/dev\/null)$/;

/** True when a word of the segment sends output to a file (`> f`, `2>>f`, `&>f`); `2>&1` and `>/dev/null` do not count. */
function redirectsToFile(words) {
  return words.some((word, index) => {
    const match = OUTPUT_REDIRECT.exec(word); // `>f`, `2>>f`, `&>f`, `>| f`, or `>` with the target next
    return match !== null && !HARMLESS_TARGET.test(match[2] || (words[index + 1] ?? ''));
  });
}

/**
 * Whether a Bash command only reads: every segment (pipes, `&&`, `;`, `$(...)` bodies) runs git or a reading command, with no
 * writing option (sed -i, find -delete/-exec) and no output sent to a file.
 * @param {string} command the Bash command
 * @returns {boolean} false for anything else, an empty command, or text that cannot be split
 */
export function isReadOnlyCommand(command) {
  try {
    const all = segments(command);
    return all.length > 0 && all.every((words) => {
      const { cmd, args } = commandOf(words);
      if (!READ_ONLY_COMMANDS.has(cmd) || redirectsToFile(words)) return false;
      return !WRITING_OPTION[cmd] || !args.some((arg) => WRITING_OPTION[cmd].test(arg));
    });
  } catch {
    return false; // cannot be split: not known to be read-only
  }
}
