// find that deletes what it finds: `find <start folders> ... -exec rm -r ... {} +`, `-delete`.
// Exports: checkFind(args, env) -> reason | undefined.
// The start folders decide what can be removed, so they are judged like the targets of `rm -r` (outside the project, or
// `~`, `$HOME`, an unknown variable, asks). `find . -name node_modules -prune -exec rm -rf {} +` inside the project stays silent.
// A find that only lists, or runs a non-recursive rm, is not judged here. Invariants: pure; never touches the file system.
import { checkRm } from './rm-paths.mjs';
import { QUOTED_MARK, basenameOf } from './shell-words.mjs';
import { destructive } from './verdict.mjs';

const EXEC_PRIMARIES = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const LEADING_OPTION = /^-(?:[HLP]|O\d?)$/;
const RECURSIVE_RM_FLAG = /^--recursive$|^-[a-zA-Z]*[rR]/;
const PROBE_CHILD = '/x'; // the folder itself may be the project root; what find removes is below it
const EXEC_END = new Set([';', '\;', '+']);

/** Start folders: the words before the first expression word (`-name`, `(`, `!`); `.` when there are none. */
function startFolders(args) {
  const folders = [];
  let i = 0;
  while (i < args.length && (LEADING_OPTION.test(args[i]) || args[i] === '-D')) i += args[i] === '-D' ? 2 : 1;
  for (; i < args.length && !args[i].startsWith('-') && args[i] !== '(' && args[i] !== '!'; i++) folders.push(args[i]);
  return folders.length > 0 ? folders : ['.'];
}

/** True when the find deletes: `-delete`, or an exec of `rm` with a recursive flag. */
function deletes(args) {
  return args.some((word, i) => {
    if (word === '-delete') return true;
    if (!EXEC_PRIMARIES.has(word) || basenameOf(args[i + 1] ?? '') !== 'rm') return false;
    const rmArgs = args.slice(i + 2);
    const end = rmArgs.findIndex((a) => EXEC_END.has(a));
    return (end === -1 ? rmArgs : rmArgs.slice(0, end)).some((a) => RECURSIVE_RM_FLAG.test(a));
  });
}

/**
 * @param {string[]} args words after `find`
 * @param {{cwd: string|null, project: string, vars: Map<string, string>}} env same as checkRm
 * @returns {string | undefined} ask reason when a deleting find starts outside the project
 */
export function checkFind(args, env) {
  if (!deletes(args)) return undefined;
  const outside = startFolders(args).find((folder) => checkRm(['-r', folder.replace(/\/+$/, '') + PROBE_CHILD], env) !== undefined);
  return outside === undefined ? undefined : destructive(`find deleting outside the project (${outside.replace(QUOTED_MARK, '')})`);
}
