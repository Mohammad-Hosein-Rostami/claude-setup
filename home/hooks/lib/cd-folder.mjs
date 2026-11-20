// The folder a command line is in while the Bash guard reads it, as far as the line's `cd`s can be believed. Read by pre-bash-guard.mjs.
// Exports: newFolder(cwd) -> {dir, start, followed, moved, compound}; enterSegment(folder, seg, parsed, words); leaveSegment(folder, seg, parsed, {project, scope});
// nextCwd(parsed, cwd, project, scope) -> folder | null.
// `dir` is the folder the next command runs in, or null for "unknown": then a relative `rm -r` target asks and an absolute one is still
// judged (lib/rm-paths.mjs). Unknown is final for the line: nothing here makes the folder known again.
// `start` (where the line began) and `followed` (where its `cd`s lead when each is taken at its word, null when one cannot be read) are
// the folders the line may be in once `dir` is unknown: an absolute target that names one of them, or a bare glob of it, still asks.
// The rule fails closed: a `cd` (also `pushd`, `popd`) is believed only inside its own `&&` chain.
// - After a `cd`, the next command is in the new folder only when `&&` joins it. Any other join (`;`, a newline, `||`, `|`, `&`, the end
//   of a `( )` group) means the `cd` may have failed, or have run in a subshell, in the background or not at all: unknown.
// - A `cd` is believed only where a chain can start (the start of the line, after `;` or a newline) or continue (`&&`), and only while
//   the line has shown no compound command (`{ }`, `if`, `case`, a loop, a function body, `!`): in one it may run later, more than once
//   or not at all. A `cd` right after `(`, `||`, `|` or `&` is not believed either.
// - `eval`, `source` and `.` run text the guard does not read; `setopt autocd` and `shopt -s cdable_vars` change what a bare word or a
//   `cd` argument means: unknown from there on.
// - A target the shell resolves from state the guard does not have is unknown: `-` and `+N` (the folder stack), `~user`, an expansion,
//   a glob, a bare drive (`C:` is the folder Windows remembers for that drive), and any relative target while CDPATH is set, in the
//   line or in the environment.
// Invariants: pure apart from reading process.env.CDPATH; never touches the file system; a segment whose parser recorded no join
// (`seg.joinedBy`, lib/shell-words.mjs) counts as "not `&&`".
import { isAbsolute, resolve } from 'node:path';
import { KEYWORDS } from './command-of.mjs';
import { PWD_TARGET, expandHome, expandVars, isUnder, nativePath, sameFile } from './rm-paths.mjs';
import { GIT_TOPLEVEL_WORD } from './shell-words.mjs';

const MOVERS = new Set(['cd', 'pushd', 'popd']);
const UNREAD_RUNNERS = new Set(['eval', 'source', '.']);
const OPTION_SETTERS = new Set(['setopt', 'shopt', 'set']);
const CD_OPTIONS = new Set(['autocd', 'cdablevars']);
const COMPOUND_COMMANDS = new Set(['for', 'select', 'case', 'function', 'repeat', 'foreach', 'coproc']); // the keywords lib/command-of.mjs does not look through
const CHAIN_JOIN = /^&&\n*$/; // `&&`, also with the line broken after it
const START_JOIN = /^[;\n]*$/; // the start of the line, `;` or a newline
const NO_JOIN = '?'; // stands for a missing `seg.joinedBy`: neither a chain nor a start
const UNKNOWN_CD_TARGET = /^-|[~$`*?[\]{}]/;
const STACK_OR_BARE_DRIVE = /^\+|^[a-zA-Z]:$/; // `+N` walks the folder stack; `C:` is the folder Windows remembers for that drive

/** zsh reads option names without case and without `_` (`AUTO_CD` is `autocd`); bash spells `cdable_vars`. */
const isCdOption = (word) => CD_OPTIONS.has(word.toLowerCase().replaceAll('_', ''));
/** `CDPATH` (bash, zsh) or zsh's array `cdpath`. */
const isCdpath = (name) => name.toLowerCase() === 'cdpath';
const assignedName = (word) => word.split(/[+=[]/, 1)[0];

/** True when a relative `cd` may land somewhere else: CDPATH is set in the environment, earlier in the line, or in front of this `cd`. */
const cdpathIsSet = (assigns, assigned) => Boolean(process.env.CDPATH) || [...assigned].some(isCdpath) || assigns.some((word) => isCdpath(assignedName(word)));

/**
 * The folder state at the start of a command line.
 * @param {string | null} cwd the folder the line starts in, null when unknown
 * @returns {{dir: string | null, start: string | null, followed: string | null, moved: boolean, compound: boolean}} dir: where the next
 *   command runs (null: unknown); start: where the line began; followed: where the `cd`s lead when each is taken at its word; moved: a
 *   `cd` was seen; compound: a compound command was seen
 */
export const newFolder = (cwd) => ({ dir: cwd, start: cwd, followed: cwd, moved: false, compound: false });

/**
 * Call before a segment is judged: after a `cd`, a segment that `&&` does not join runs in an unknown folder.
 * @param {ReturnType<typeof newFolder>} folder the line's state (modified)
 * @param {string[] & {joinedBy?: string}} seg the segment as the parser gave it
 * @param {{cmd?: string, at: number}} parsed its command (lib/command-of.mjs)
 * @param {string[]} words its words, the ones `parsed.at` counts
 */
export function enterSegment(folder, seg, parsed, words) {
  if (folder.moved && !CHAIN_JOIN.test(seg.joinedBy ?? NO_JOIN)) folder.dir = null;
  folder.compound ||= COMPOUND_COMMANDS.has(parsed.cmd) || words.slice(0, parsed.at).some((word) => KEYWORDS.has(word));
}

/**
 * Call after a segment was judged: applies its `cd`, or makes the folder unknown for a command that hides one.
 * @param {ReturnType<typeof newFolder>} folder the line's state (modified)
 * @param {string[] & {joinedBy?: string}} seg the segment as the parser gave it
 * @param {{cmd?: string, args: string[], assigns?: string[]}} parsed its command
 * @param {{project: string, scope: {vars: Map<string, string>, assigned?: Set<string>}}} line the project root and the line's variables
 */
export function leaveSegment(folder, seg, parsed, { project, scope }) {
  const { cmd, args } = parsed;
  if (UNREAD_RUNNERS.has(cmd) || (OPTION_SETTERS.has(cmd) && args.some(isCdOption))) folder.dir = null;
  if (!MOVERS.has(cmd)) return;
  folder.followed = nextCwd(parsed, folder.followed, project, scope, false);
  const join = seg.joinedBy ?? NO_JOIN;
  const believed = !folder.compound && (START_JOIN.test(join) || CHAIN_JOIN.test(join));
  folder.dir = believed ? nextCwd(parsed, folder.dir, project, scope) : null;
  folder.moved = true;
}

/** Like expandHome; the git top-level word -> the project, but only from inside it (elsewhere the top-level is unknown). */
function expandCdTarget(target, cwd, project) {
  if (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`)) return expandHome(target);
  const root = resolve(nativePath(project));
  const inside = sameFile(resolve(cwd), root) || isUnder(root, resolve(cwd));
  return inside ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/**
 * Working directory after `cd`/`pushd`/`popd`: a literal target is resolved, anything else makes it unknown.
 * @param {{cmd: string, args: string[], assigns?: string[]}} parsed the `cd` command with the `NAME=value` words in front of it
 * @param {string | null} cwd the folder before it
 * @param {string} project the project root
 * @param {{vars: Map<string, string>, assigned?: Set<string>}} scope the line's variables (lib/rm-paths.mjs newScope)
 * @param {boolean} [strict] false takes `+N`, a bare drive and a relative target under CDPATH at their word (for `followed`)
 * @returns {string | null} the folder after it, null when unknown
 */
export function nextCwd({ cmd, args, assigns = [] }, cwd, project, { vars, assigned = new Set() }, strict = true) {
  if (cmd === 'popd' || cwd === null || args.length !== 1) return null;
  if (PWD_TARGET.test(args[0]) && vars.get('PWD') !== cwd) return null; // `cd "$PWD"/x` after the folder moved: not guessed, unknown from here on
  const target = expandVars(expandCdTarget(args[0], cwd, project), vars); // `cd "$D"` after `D=$(mktemp -d)` is the temp dir
  if (UNKNOWN_CD_TARGET.test(target)) return null;
  if (strict && (STACK_OR_BARE_DRIVE.test(target) || (!isAbsolute(nativePath(target)) && cdpathIsSet(assigns, assigned)))) return null;
  return resolve(cwd, nativePath(target));
}
