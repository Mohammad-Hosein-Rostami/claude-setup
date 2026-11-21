// The folders a command line may be in while the Bash guard reads it, as far as the line's `cd`s can be known. Read by pre-bash-guard.mjs.
// Exports: newFolder(cwd); enterSegment(folder, seg, parsed, words); leaveSegment(folder, parsed, {project, scope});
// possibleFolders(folder, seg, work) -> (folder | null)[]; maybeFolders(folder) -> (folder | null)[]; nextCwd(parsed, cwd, project, scope) -> folder | null;
// MAX_POSSIBLE_FOLDERS.
// A shell line does not always say which folder a command runs in: after `cd src; x` the `cd` may have failed, so `x` runs in `src` or in
// the folder before it. The state is therefore a SET of possible folders (`dirs`), and the guard judges a command once in every member
// (possibleFolders): it runs unasked only when it is fine from all of them. null stands for "unknown": then a relative `rm -r` target
// asks, and an absolute one is judged against every folder the line was ever seen in (maybeFolders).
// The rules:
// - Inside its own `&&` chain a `cd` (also `pushd`) is believed: `cd X && rm -r y` judges `y` in X alone, at the top level and inside
//   `( )`, `{ }`, `if`/`then`/`else` and a `case` branch. A pipeline between two `&&` keeps the chain (`cd X && a | b && c`: `c` runs
//   only when the `cd` did), unless the pipeline itself holds a `cd`.
// - When the chain ends (`;`, a newline, `||`, `&`, a pipe after the `cd`, the end of a group), the `cd` may or may not have taken
//   effect: the set becomes every folder the chain passed through, the one before each `cd` and the one after.
// - A `cd` that cannot be taken at its word is added to the set at once instead of replacing it: one after `||`, `|` or `!`, and one
//   behind a word that is not a plain shell prefix (`sudo cd x` changes nothing in this shell).
// - A set over MAX_POSSIBLE_FOLDERS members is unknown. So is one with a member the guard cannot know: a target the shell resolves
//   from state the guard lacks (`-`, `+N`, `~user`, an expansion, a glob, a bare drive, any relative target while CDPATH is set), a
//   `popd`, and anything after `eval`, `source` or `.` (they run text the guard does not read) or after `setopt autocd` /
//   `shopt -s cdable_vars` (they change what a bare word or a `cd` argument means).
// - A relative `cd` inside a loop or a function body is unknown too: the body may run again, and each run moves on from where the last
//   one stopped (`cd ..` three times), so "before and after" does not list the folders. A loop ends at its `done`; a function body is
//   not followed to its end, so the rest of the line counts as inside it.
// - Judging a segment once more per extra folder is work the line pays for (possibleFolders): a script nested in a script could
//   multiply it by MAX_POSSIBLE_FOLDERS at every level. A line that has spent its budget is judged with the folder unknown, and asks.
// - An absolute `cd` is known wherever the line was: inside its chain the folder is that one, also after an unknown one (too many
//   folders, `eval`, `source`, a loop). One unknown is final all the same: after a `cd`, `pushd` or `popd` whose own target could not be
//   read (`followed` is null). The guard asked about the rest of such a line before it kept a set, and no rule here may drop an ask.
// - Round 9 (r9-guard-deleters): a line that defines `cd`, `pushd` or `popd` as a function or alias (any spelling, also in `eval` text) makes
//   the folder unknown for good (`followed` null): its later absolute `cd` may run the replacement. A command that may run a `cd` among its
//   own words (CD_HIDERS: `noglob`, `repeat`, the short `if`, `trap`) makes it unknown too; `env -C` / `sudo --chdir` make it unknown for
//   that one command. In zsh `command cd x` runs the external `cd`, so `command` is no plain prefix. `~` is unknown once the line assigns HOME.
// Invariants: pure apart from reading process.env.CDPATH; never touches the file system; a segment whose parser recorded no join
// (`seg.joinedBy`, lib/shell-words.mjs) neither continues a chain nor has its `cd` believed; nothing here ever makes the set smaller
// than the folders the shell can really be in, short of the limits named in pre-bash-guard.mjs.
import { isAbsolute, resolve } from 'node:path';
import { MAX_LINE_EXPANDED_CHARS, PWD_TARGET, expandHome, expandVars, isUnder, nativePath, sameFile } from './rm-paths.mjs';
import { GIT_TOPLEVEL_WORD } from './shell-words.mjs';

/** The most folders a command is judged in. A line whose `cd`s leave more open than this is not worth following: it asks like an unknown one. */
export const MAX_POSSIBLE_FOLDERS = 4;
const MAX_REMEMBERED_FOLDERS = 16; // bounds the work per absolute target of a line with hundreds of `cd`s; the first ones seen are kept
const MOVERS = new Set(['cd', 'pushd', 'popd']);
const UNREAD_RUNNERS = new Set(['eval', 'source', '.']);
const OPTION_SETTERS = new Set(['setopt', 'shopt', 'set']);
const CD_OPTIONS = new Set(['autocd', 'cdablevars']);
const LOOP_COMMANDS = new Set(['for', 'select', 'repeat', 'foreach']); // the loop words lib/command-of.mjs does not look through
const LOOP_KEYWORDS = new Set(['while', 'until']);
const LOOP_END = 'done';
const FUNCTION_COMMAND = 'function';
const FUNCTION_JOIN = '()'; // `f() { ...`: the body's first command is joined by the empty parentheses
// words that may stand in front of a `cd` without changing whether or where it runs in this shell
// not `command`: in zsh `command cd` runs no builtin
const PLAIN_PREFIXES = new Set(['{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'builtin']);
const ASSIGNMENT_WORD = /^[A-Za-z_]\w*\+?=/;
const CHAIN_JOIN = /^&&\n*$/; // `&&`, also with the line broken after it
const PIPE_JOIN = /^\|&?\n*$/;
const UNSURE_JOIN = /\|&?\n*$/; // the last operator is `|`, `|&` or `||`: the `cd` runs in a subshell, or only when the command before failed
const UNKNOWN_CD_TARGET = /^-|[~$`*?[\]{}]/;
const STACK_OR_BARE_DRIVE = /^\+|^[a-zA-Z]:$/; // `+N` walks the folder stack; `C:` is the folder Windows remembers for that drive
// commands that may run a `cd` among their own words in this shell: zsh `noglob cd x`, `repeat 2 cd ..`, the short `if [[ c ]] cd x`,
// `trap 'cd ..' DEBUG`, a loop without `do`
const CD_HIDERS = new Set(['noglob', 'nocorrect', 'repeat', 'trap', '[[', '[', 'test', 'if', 'elif', 'while', 'until', 'for', 'foreach', 'select']);
const MOVER_WORD = /(?:^|[\s;&|({])\\?(?:cd|pushd|popd)(?=$|[\s;&|)}])/;
// a function or alias that replaces a folder mover: `function cd {`, `cd() {`, `alias cd=...`, also inside `eval` text
const MOVER_DEFINITION = new RegExp([
  String.raw`(?:^|[\s;&|({])(?:function\s+)?\\?['"]?(?:cd|pushd|popd)['"]?\s*\(\s*\)`, // `cd() {`, `function cd () {`
  String.raw`\bfunction\s+\\?['"]?(?:cd|pushd|popd)\b`, // `function cd {`
  String.raw`\balias\s+(?:-\w+\s+)*['"]?(?:cd|pushd|popd)=`, // `alias cd=...`
].join('|'));
const CHDIR_WRAPPER_OPTION = { env: /^(?:-C|--chdir)(?:=|$)|^-C./, sudo: /^(?:-D|--chdir)(?:=|$)|^-D./ }; // `env -C dir`, `sudo --chdir=dir`

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
 * @returns {{dirs: string[] | null, passed: string[] | null, everIn: string[], followed: string | null, believes: boolean,
 *   cdLast: boolean, loops: number, inFunction: boolean}} dirs: the folders the next command may run in (null: unknown); passed: the
 *   folders the current `&&` chain left behind; everIn: every folder a command of the line may have run in; followed: where the `cd`s
 * lead when each is taken at its word, null for good once one cannot be read; believes: a `cd` in the current segment is believed; cdLast: the segment before
 * was a `cd`;
 *   loops: open loops; inFunction: a function body was opened; elsewhere: the current command runs in a folder a wrapper chose (`env -C`);
 *   moved: the line has a `cd`, `pushd` or `popd`, or hid one (pre-bash-guard.mjs then judges nested bodies with the folder unknown)
 */
export const newFolder = (cwd) => ({
  dirs: cwd === null ? null : [cwd], passed: [], everIn: cwd === null ? [] : [cwd], followed: cwd, believes: false, cdLast: false, loops: 0,
  inFunction: false, elsewhere: false, moved: false,
});

/**
 * The folders the next command is judged in. Every folder past the first means the segment is read once more; those characters are
 * charged to the line's budget (lib/rm-paths.mjs newWork, the half that also bounds filled-in variables), so nested scripts cannot
 * multiply the guard's work without end.
 * @param {ReturnType<typeof newFolder>} folder the line's state
 * @param {string[]} seg the segment about to be judged
 * @param {{expanded: number, spent: boolean}} work the line's budget (modified)
 * @returns {(string | null)[]} every folder it may run in, or one null when that is unknown or the budget is spent (the line then asks)
 */
export function possibleFolders(folder, seg, work) {
  if (folder.dirs === null || folder.elsewhere || work.spent) return [null];
  work.expanded += (folder.dirs.length - 1) * seg.reduce((chars, word) => chars + word.length + 1, 0);
  work.spent = work.expanded > MAX_LINE_EXPANDED_CHARS;
  return work.spent ? [null] : folder.dirs;
}

/**
 * The folders an absolute target is held against when the folder is unknown (lib/rm-paths.mjs checkRm `maybeCwds`).
 * @param {ReturnType<typeof newFolder>} folder the line's state
 * @returns {(string | null)[]} every folder the line was seen in, and where its `cd`s lead when each is taken at its word
 */
export const maybeFolders = (folder) => [...folder.everIn, folder.followed];

/** Both sets together; null (unknown) when either is, or when there are more than MAX_POSSIBLE_FOLDERS. */
function union(some, more) {
  if (some === null || more === null) return null;
  const all = [...some];
  for (const dir of more) if (!all.some((have) => sameFile(have, dir))) all.push(dir);
  return all.length > MAX_POSSIBLE_FOLDERS ? null : all;
}

function remember(folder, dirs) {
  for (const dir of dirs ?? []) if (folder.everIn.length < MAX_REMEMBERED_FOLDERS && !folder.everIn.includes(dir)) folder.everIn.push(dir);
}

/**
 * Call before a segment is judged: ends the `&&` chain when the segment is not part of it, and notes what kind of place the segment is.
 * @param {ReturnType<typeof newFolder>} folder the line's state (modified)
 * @param {string[] & {joinedBy?: string}} seg the segment as the parser gave it
 * @param {{cmd?: string, at: number}} parsed its command (lib/command-of.mjs)
 * @param {string[]} words its words, the ones `parsed.at` counts
 */
export function enterSegment(folder, seg, parsed, words) {
  const join = seg.joinedBy;
  const before = words.slice(0, parsed.at);
  const inChain = join !== undefined && (CHAIN_JOIN.test(join) || (PIPE_JOIN.test(join) && !folder.cdLast));
  if (!inChain) [folder.dirs, folder.passed] = [union(folder.dirs, folder.passed), []]; // every `cd` of the chain may or may not have run
  folder.cdLast = false;
  if (LOOP_COMMANDS.has(parsed.cmd) || before.some((word) => LOOP_KEYWORDS.has(word))) folder.loops += 1;
  else if (words[0] === LOOP_END && folder.loops > 0) folder.loops -= 1;
  folder.inFunction ||= parsed.cmd === FUNCTION_COMMAND || (join ?? '').includes(FUNCTION_JOIN);
  folder.believes = join !== undefined && !UNSURE_JOIN.test(join) && before.every((word) => PLAIN_PREFIXES.has(word) || ASSIGNMENT_WORD.test(word));
  folder.elsewhere = changesFolder(before); // this one command runs in a folder the guard does not follow
}

/** True when a wrapper in front of the command runs it in another folder: `env -C dir`, `sudo -D dir` / `--chdir`. */
function changesFolder(before) {
  let wrapper;
  return before.some((word) => {
    if (word === 'env' || word === 'sudo') wrapper = word;
    return wrapper !== undefined && CHDIR_WRAPPER_OPTION[wrapper].test(word);
  });
}

/** True when this command defines a folder mover or may run one the line does not show as a `cd` segment (X1, G1). */
function hidesMover({ cmd, args }) {
  const text = [cmd, ...args].join(' ');
  if (MOVER_DEFINITION.test(text)) return true; // also `eval 'cd() { builtin cd ~; }'`
  if (MOVERS.has(cmd) && (args[0] ?? '').startsWith('(')) return true; // `cd () {`
  return CD_HIDERS.has(cmd) && args.some((word) => MOVER_WORD.test(word));
}

/** Where a `cd` leads from every folder the line may be in; null when one of them cannot be known. */
function foldersAfter(folder, parsed, project, scope) {
  if (folder.followed === null) return null; // this `cd` or an earlier one could not be read at all: unknown for the rest of the line
  const fixed = nextCwd(parsed, null, project, scope); // not null for an absolute target: the same folder wherever the line was
  if (folder.dirs === null) return fixed === null ? null : [fixed];
  if (fixed === null && (folder.loops > 0 || folder.inFunction)) return null; // a relative `cd` that may run again
  const all = folder.dirs.map((dir) => nextCwd(parsed, dir, project, scope));
  return all.includes(null) ? null : union([], all);
}

/**
 * Call after a segment was judged: applies its `cd`, or makes the folder unknown for a command that hides one.
 * @param {ReturnType<typeof newFolder>} folder the line's state (modified)
 * @param {{cmd?: string, args: string[], assigns?: string[]}} parsed the segment's command
 * @param {{project: string, scope: {vars: Map<string, string>, assigned?: Set<string>}}} line the project root and the line's variables
 */
export function leaveSegment(folder, parsed, { project, scope }) {
  const { cmd, args } = parsed;
  const hidesCd = UNREAD_RUNNERS.has(cmd) || (OPTION_SETTERS.has(cmd) && args.some(isCdOption)) || (cmd === FUNCTION_COMMAND && args.some((word) => MOVERS.has(word)));
  folder.elsewhere = false;
  if (hidesCd) folder.dirs = null; // `function f { cd x`: the parsers leave the body's first command among the words of `function`
  if (hidesMover(parsed)) [folder.dirs, folder.followed] = [null, null]; // an absolute `cd` may then run the replacement: never known again
  folder.moved ||= MOVERS.has(cmd) || folder.dirs === null;
  if (!MOVERS.has(cmd)) return;
  folder.cdLast = true;
  folder.followed = folder.followed === null ? null : nextCwd(parsed, folder.followed, project, scope, false);
  const after = foldersAfter(folder, parsed, project, scope);
  remember(folder, after);
  if (folder.believes) [folder.passed, folder.dirs] = [union(folder.passed, folder.dirs), after];
  else folder.dirs = union(folder.dirs, after);
}

/** Like expandHome (unknown once the line assigned HOME); the git top-level word -> the project, but only from inside it. */
function expandCdTarget(target, cwd, project, vars) {
  if (cwd === null || (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`))) return expandHome(target, vars);
  const root = resolve(nativePath(project));
  const inside = sameFile(resolve(cwd), root) || isUnder(root, resolve(cwd));
  return inside ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/**
 * Working directory after `cd`/`pushd`/`popd`: a literal target is resolved, anything else makes it unknown.
 * @param {{cmd: string, args: string[], assigns?: string[]}} parsed the `cd` command with the `NAME=value` words in front of it
 * @param {string | null} cwd the folder before it; null (unknown) still gives a folder for an absolute target
 * @param {string} project the project root
 * @param {{vars: Map<string, string>, assigned?: Set<string>}} scope the line's variables (lib/rm-paths.mjs newScope)
 * @param {boolean} [strict] false takes `+N`, a bare drive and a relative target under CDPATH at their word (for `followed`)
 * @returns {string | null} the folder after it, null when unknown
 */
export function nextCwd({ cmd, args, assigns = [] }, cwd, project, { vars, assigned = new Set() }, strict = true) {
  if (cmd === 'popd' || args.length !== 1) return null;
  if (PWD_TARGET.test(args[0]) && vars.get('PWD') !== cwd) return null; // `cd "$PWD"/x` after the folder moved: not guessed
  const target = expandVars(expandCdTarget(args[0], cwd, project, vars), vars); // `cd "$D"` after `D=$(mktemp -d)` is the temp dir
  if (UNKNOWN_CD_TARGET.test(target)) return null;
  const isRelative = !isAbsolute(nativePath(target));
  if (isRelative && cwd === null) return null;
  if (strict && (STACK_OR_BARE_DRIVE.test(target) || (isRelative && cdpathIsSet(assigns, assigned)))) return null;
  return cwd === null ? resolve(nativePath(target)) : resolve(cwd, nativePath(target));
}
