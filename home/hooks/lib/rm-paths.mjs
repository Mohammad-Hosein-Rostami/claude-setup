// Path rules for `rm -r`: is a target inside the project or a temp dir, and which variables hold what (the folder after a `cd`: lib/cd-folder.mjs).
// Exports: checkRm(args, {cwd, project, vars}) -> reason | undefined; MAX_TARGET_CHARS; MAX_LINE_READINGS; TOO_COMPLEX_REASON; newWork();
// PWD_TARGET; expandVars; shown(target) -> the target as a reason shows it; newScope(cwd, project) -> {vars, assigned};
// trackAssignments(scope, tokens, nextTokens); substituteKnownWords(tokens, scope); bashReadings(word, splitWords) (also read by
// lib/find-delete.mjs); nativePath, isUnder, sameFile, expandHome; RECURSIVE_FLAG; withoutRedirects(args) (also read by lib/git-runs.mjs);
// DECLARERS (from lib/shell-words.mjs, also read by lib/git-run-values.mjs).
// An unquoted `$D` whose value has blanks is judged as one path (zsh) and as the words bash splits it into; `X[2]=v` makes X unknown.
// Variables are tracked in order within one command line and the LAST assignment wins (`D=$(mktemp -d); D=/etc` means /etc).
// A literal value is used as is, `VAR=$(mktemp -d)` (default location; the tokenizer turns it into MKTEMP_WORD, also with a path
// suffix `$(mktemp -d)/..` and in backticks) stands for one directory inside the temp dir, `D+=x` appends, and any
// other value is unknown. `..` is resolved lexically after substitution, so `$D/..` is outside the mktemp directory.
// Brace expansion in targets (`{/,x}`) is expanded first; one that cannot be listed asks.
// `$(git rev-parse --show-toplevel)` counts as the project root from a directory inside the project (`rm -rf "$(git rev-parse --show-toplevel)/dist"`).
// Only a recursive rm asks about an unknown or outside target; `rm -f x` of one file is not judged here. An rm whose options the guard
// cannot read counts as recursive (rmKind; its reasons say "rm that may be recursive", not "rm -r"): `-$X`, `"$@"`, `"${a[@]}"`, or one variable where the options stand (`rm $F ~`).
// Inside the project a recursive rm still asks when it empties a whole folder: the working directory itself, or a bare glob (`*`, `./*`,
// `.*`, `?`, `[a-z]*`) of the working directory, the project root, home, `/` or a temp root (`/tmp/*` empties every session's scratch folder).
// A glob with a name part (`*.log`) or of a sub-folder does not.
// A bare glob below a bare glob (`./**/*`, `*/*`) counts as a glob of the folder the first one is in: it empties every sub-folder there
// (lib/bare-glob.mjs reads the globs). Work budget: a target over MAX_TARGET_CHARS is not read, it asks. One budget for the whole line
// as well (newWork): MAX_LINE_READINGS target readings over both parsers and every wrapped or nested rm; over it the rm asks
// "command too complex to check" and no more targets are read on that line. The same budget bounds what the line's variables are filled
// in with (substituteKnownWords): past MAX_LINE_EXPANDED_CHARS nothing more is filled in and the whole line asks.
// `$PWD` (also written `${PWD}` or `$(pwd)`) in a target is the folder the line's `cd`s led to, unknown after a `cd` the guard could not follow;
// the value the line started with or assigned is judged as well (readingsOf), so following the `cd` never drops an ask.
// Invariants: pure apart from reading homedir()/tmpdir(); never touches the file system.
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { globbedFolder } from './bare-glob.mjs';
import { expandBraces } from './braces.mjs';
import { DECLARERS, GIT_TOPLEVEL_WORD, MKTEMP_WORD, QUOTED_MARK, backtickAssignedNames, flagsOf } from './shell-words.mjs';
import { MAX_COMMAND_CHARS, destructive } from './verdict.mjs';

export { DECLARERS };

const SAFE_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const GIT_BASH_DRIVE_ROOT = /^\/[a-zA-Z]$/;
const REDIRECT_START = /^(\d*>>?|\d*<|&>>?)/;
const REDIRECT_OPERATOR_ONLY = /^(\d*>>?|\d*<{1,2}|&>>?)$/;
const VAR_PREFIX = /^\$\{?(\w+)\}?(?=\/|$)/;
export const PWD_TARGET = /^\$(?:PWD|\{PWD\})(?=\/|$)/; // `$(pwd)` and a backtick pwd reach here as `$PWD` (lib/shell-words.mjs)
const MKTEMP_NAME = MKTEMP_WORD.slice(1);
const ANY_VAR = /\$\{(\w+)\}|\$(\w+)/g;
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const SUBSCRIPT_ASSIGNMENT = /^([A-Za-z_]\w*)\[[^\]]*\]\+?=/; // `X[2]=v`: zsh changes part of a scalar, so its value is no longer known
const MKTEMP_DIR = 'mktemp-variable';
const BLANKS = /[ \t\n]+/; // where bash splits an unquoted variable's value into words (the default IFS)
/** Work budget for one rm target: PATH_MAX is 4096 on Linux and 1024 on macOS, so a longer word is no path a real command names. */
export const MAX_TARGET_CHARS = 4096;
/** Work budget for one command line: the target readings the rm rule judges, over both parsers and every wrapped or nested rm. An unquoted
 * variable of thousands of words, used thousands of times, has millions: it kept the hook busy past its timeout (an ordinary line has a handful). */
export const MAX_LINE_READINGS = 20000;
/** The other half of the budget: the characters the line's own variables may be filled in with, over both parsers. Every rule reads the
 * filled-in words, so a long value used thousands of times made each rule scan tens of megabytes. Far above any line someone writes. */
export const MAX_LINE_EXPANDED_CHARS = 4 * MAX_COMMAND_CHARS;
export const TOO_COMPLEX_REASON = 'command too complex to check (its rm targets expand to more words than the guard reads); read it before allowing';
/** @returns {{readings: number, expanded: number, spent: boolean}} a fresh budget for one line; spent once either count ran out: the line then asks */
export const newWork = () => ({ readings: 0, expanded: 0, spent: false });
const MAX_SHOWN_TARGET_CHARS = 120; // how much of a target a reason repeats: the reason goes into the dialog and back to the model
const LINE_BREAKS = /[\r\n]+/g;
const LINE_BREAK_MARK = '⏎'; // a raw line break in a target would split the reason in the CLI prompt and in the text the model reads
const prefixesOf = (word) => Array.from(word, (_, index) => word.slice(0, index + 1));
/**
 * An rm option that deletes recursively: `-r`, `-R`, a cluster holding one (`-rf`, `-fR`), `--recursive`, or a prefix of it (`--rec`, `--r`):
 * GNU rm (Linux, Git Bash) takes any unambiguous prefix of a long option, and no other long option of rm starts with r. A prefix of
 * `--no-preserve-root` counts too (no other starts with n): it is only written for a recursive delete.
 */
export const RECURSIVE_FLAG = new RegExp(`^--(?:${[...prefixesOf('recursive'), ...prefixesOf('no-preserve-root')].join('|')})$|^-[a-zA-Z]*[rR]`);

/**
 * Git Bash paths (`/c/Users/x`) -> `c:/Users/x` on Windows; unchanged elsewhere. A bare drive (`/c`) is the drive ROOT, `c:/`: a plain
 * `c:` means "the current folder on drive c" to Windows, so `cd /c` would look like a cd that did not move.
 */
export const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?:\/|$)/, '$1:/') : p);

export const isUnder = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
export const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `~`, `~/x`, `$HOME`, `${HOME}` -> the home directory. Other words are unchanged. */
export const expandHome = (target) => target.replace(HOME_PREFIX, homedir());

/** $HOME, `/`, a drive root (`C:\`, `/c/`) are never "the project": a session started there would allow rm -r anywhere. */
function isBroadRoot(project) {
  const path = resolve(nativePath(project));
  return sameFile(path, parse(path).root) || sameFile(path, resolve(homedir())) || GIT_BASH_DRIVE_ROOT.test(path);
}

/**
 * Variable state for one command line: `vars` maps names to known values (`$TMPDIR`, `$CLAUDE_PROJECT_DIR`, `$PWD` when the
 * directory is known, then every literal assignment seen so far); `assigned` holds the names assigned in the command itself; `unknown`
 * the names `command` assigns from a backtick, whose value the parsers lose (always unknown).
 */
export function newScope(cwd, project, command = '', work = newWork()) {
  const vars = new Map([['TMPDIR', tmpdir()], ['CLAUDE_PROJECT_DIR', project], [MKTEMP_NAME, mktempDir()]]);
  if (cwd !== null) vars.set('PWD', cwd);
  return { vars, assigned: new Set(), unknown: backtickAssignedNames(command), splitWords: new Set(), work };
}

/**
 * A target as bash may read it: a word that substituteKnownWords filled from an unquoted variable whose value has blanks is also each of
 * its blank-separated words (bash splits it, zsh keeps one word: both readings are judged).
 * @param {string} word one target word
 * @param {Set<string>} [splitWords] the scope's splitWords
 * @returns {string[]} the word, then the words bash splits it into
 */
export const bashReadings = (word, splitWords) => (splitWords?.has(word) ? [word, ...word.split(BLANKS).filter(Boolean)] : [word]);

export const expandVars = (target, vars) => target.replace(VAR_PREFIX, (whole, name) => (vars.has(name) ? vars.get(name) : whole));
const mktempDir = () => join(tmpdir(), MKTEMP_DIR);
const isMktempValue = (value) => typeof value === 'string' && value.startsWith(mktempDir());

/** The value a `NAME=value` word gives, or undefined when it cannot be known (`$(...)` other than the mktemp stand-in). */
function valueOf(raw, vars) {
  if (raw === '$' || raw === '`') return undefined; // a bare `$(`/backtick: the value is another command's output
  const value = expandVars(expandHome(raw), vars);
  return /[$`]/.test(value) ? undefined : value;
}

/**
 * Updates `vars` for assignments in one segment (a bare `NAME=x` segment or `export NAME=x`), `unset`, `read`. Call after the
 * segment was checked. Names that become unknown are removed, so a later `$NAME` target is unknown.
 * @param {{vars: Map<string, string>, assigned: Set<string>, unknown?: Set<string>}} scope tracked values (modified); names in unknown
 *   are never known
 * @param {string[]} tokens words of this segment
 */
export function trackAssignments({ vars, assigned, unknown = new Set() }, tokens) {
  const words = DECLARERS.has(tokens[0]) ? tokens.slice(1) : tokens;
  for (const word of words) {
    if (!ASSIGNMENT.test(word) && !SUBSCRIPT_ASSIGNMENT.test(word)) break;
    vars.delete(SUBSCRIPT_ASSIGNMENT.exec(word)?.[1]); // `X[2]=v` in front: X is no longer known
  }
  if (['unset', 'read'].includes(tokens[0])) {
    for (const name of tokens.slice(1).filter((w) => !w.startsWith('-'))) vars.delete(name);
    return;
  }
  const assignments = words.map((w) => ASSIGNMENT.exec(w));
  if (assignments.length === 0 || assignments.some((m) => m === null)) return; // a command with arguments, not assignments
  for (const [, name, append, raw] of assignments) {
    assigned.add(name);
    const added = valueOf(raw, vars);
    const value = append && added !== undefined ? (vars.has(name) ? vars.get(name) + added : undefined) : added; // `D+=x` extends the old value
    if (value === undefined || unknown.has(name)) vars.delete(name);
    else vars.set(name, value);
  }
}

/**
 * Replaces `$NAME` / `${NAME}` inside words by the literal value assigned earlier in this command line, so `X=rm; $X -rf /x`
 * reads `rm -rf /x` and `v=r; ${v}m -rf /x` too. Names never assigned here, and mktemp directories, stay as they are.
 * A word with a `$NAME` outside quotes (the segment's `.bareWords`) that gets blanks this way is added to `scope.splitWords` (bashReadings).
 * Each value filled in is charged to the line's budget (`scope.work`); once that is spent the rest stays as written and the line asks.
 * @param {string[]} tokens words of one segment
 * @param {{vars: Map<string, string>, assigned: Set<string>, splitWords?: Set<string>}} scope
 */
export function substituteKnownWords(tokens, { vars, assigned, splitWords, work = newWork() }) {
  const replace = (whole, braced, plain) => {
    const name = braced ?? plain;
    if (work.spent || !assigned.has(name) || !vars.has(name) || isMktempValue(vars.get(name))) return whole;
    work.expanded += vars.get(name).length;
    work.spent = work.expanded > MAX_LINE_EXPANDED_CHARS;
    return work.spent ? whole : vars.get(name);
  };
  const words = tokens.map((word) => word.replace(ANY_VAR, replace));
  for (const at of tokens.bareWords ?? []) if (words[at] !== tokens[at] && BLANKS.test(words[at])) splitWords?.add(words[at]);
  return words;
}

/** `$(git rev-parse --show-toplevel)` is the project root, but only from a directory inside the project (elsewhere it is unknown). */
function expandToplevel(target, cwd, project) {
  if (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`)) return target;
  if (cwd === null) return target;
  const root = resolve(nativePath(project));
  const here = resolve(nativePath(cwd));
  return sameFile(here, root) || isUnder(root, here) ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/**
 * The variable values one rm target is judged with. A `$PWD` target is read with PWD as the folder the line's `cd`s led to (`cwd`; no
 * value when the guard could not follow one, so the target is unknown and asks), and also with the value the line started with or
 * assigned: that second reading is what the guard judged before it followed `cd`, and keeping it means no ask is ever lost.
 * @param {string} target one rm target as written
 * @param {string | null} cwd the tracked working directory
 * @param {Map<string, string>} vars the scope's known values
 * @returns {Map<string, string>[]} one map, or two for a `$PWD` target whose tracked folder differs from the scope's PWD
 */
function readingsOf(target, cwd, vars) {
  if (!PWD_TARGET.test(target) || vars.get('PWD') === cwd) return [vars];
  const followed = new Map(vars);
  if (cwd === null) followed.delete('PWD');
  else followed.set('PWD', cwd);
  return [followed, vars];
}

/** A target with `$(git rev-parse --show-toplevel)`, `~`/`$HOME` and the known variables filled in. */
const expandedTarget = (rawTarget, cwd, project, vars) => expandVars(expandHome(expandToplevel(rawTarget, cwd, project)), vars);

/** `cwd` is null when an earlier `cd` could not be resolved: then only absolute targets can be judged. */
function insideProject(rawTarget, cwd, project, vars) {
  const target = expandedTarget(rawTarget, cwd, project, vars);
  if (target.startsWith('~') || target.includes('$')) return false;
  const native = nativePath(target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? project, native);
  // `$D/..` and `$D/../x` leave the unique directory mktemp made, so they only count as safe while they stay inside it
  if (target.startsWith(mktempDir())) return abs === mktempDir() || isUnder(mktempDir(), abs);
  return (!isBroadRoot(project) && isUnder(project, abs)) || SAFE_TEMP_ROOTS.some((root) => isUnder(root, abs));
}

/**
 * True when the target is the working directory itself, or a bare glob (also one below other bare globs, lib/bare-glob.mjs) whose folder is
 * the working directory, the project root, home, a temp root or a file-system root: removing it empties that whole folder even though every entry is
 * inside the project. Unknown targets return false (insideProject already asks about them). After a `cd` the guard could not follow
 * (`cwd` null) an absolute target is still judged, against the project root, home, the roots and `heres`, the folders the line may be in (lib/cd-folder.mjs); a relative one was asked about already.
 */
function emptiesWholeFolder(rawTarget, { cwd, project, heres }, vars) {
  const target = expandedTarget(rawTarget, cwd, project, vars).replace(QUOTED_MARK, '');
  if (target.startsWith('~') || target.includes('$')) return false;
  const folder = globbedFolder(target);
  const native = nativePath(folder ?? target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? native, native);
  const isHere = heres.some((here) => sameFile(abs, resolve(nativePath(here))));
  if (folder === undefined) return isHere;
  const wholeFolders = [project, homedir(), ...SAFE_TEMP_ROOTS].map((whole) => resolve(nativePath(whole)));
  return isHere || wholeFolders.some((whole) => sameFile(abs, whole)) || sameFile(abs, parse(abs).root) || GIT_BASH_DRIVE_ROOT.test(abs);
}

/** A target as a reason shows it: without the quote mark, and only its start when it is long (the agent wrote it; it is not ours to repeat in full). */
export function shown(target) {
  const text = target.replace(QUOTED_MARK, '').replace(LINE_BREAKS, LINE_BREAK_MARK);
  return text.length > MAX_SHOWN_TARGET_CHARS ? `${text.slice(0, MAX_SHOWN_TARGET_CHARS)}… (${text.length} characters)` : text;
}

/** Drops redirections (`2>&1`, `> file`) so they are not mistaken for rm targets. */
export function withoutRedirects(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!REDIRECT_START.test(args[i])) out.push(args[i]);
    else if (REDIRECT_OPERATOR_ONLY.test(args[i])) i++; // the operator stands alone: its target is the next word
  }
  return out;
}

/** Every reading of the targets (bashReadings), or null when the line's budget does not cover them: from then on the line is spent. */
function readingsWithin(work, targets, splitWords) {
  const words = [];
  for (const target of targets) {
    const readings = work.spent ? [] : bashReadings(target, splitWords);
    work.spent ||= work.readings + readings.length > MAX_LINE_READINGS;
    if (work.spent) return null;
    work.readings += readings.length;
    words.push(...readings);
  }
  return words;
}

const EXPANSION = /[$`]/;
const MANY_WORDS = /\$[@*]|\[[@*]\]\}/; // `"$@"`, `$*`, `"${a[@]}"`: any number of words, options among them
const WHOLE_EXPANSION = /^\$(?:\w+|\{[^}]*\})$/; // a word that is one variable and nothing else

const UNREAD_OPTIONS_RM = 'rm that may be recursive (an expansion can hold its options)'; // how a reason names an rm that is not `-r` as written
/**
 * How a reason names the rm, undefined when it is not judged: `rm -r` when it deletes recursively as written; UNREAD_OPTIONS_RM when it may
 * once the shell has filled in its words: an option word with an expansion in it (`-$X`, `-${X:-r}f`), a word that stands for any number of words
 * (`"$@"`, `"${a[@]}"`), or one variable where the options stand, with more words after it (`rm $F ~` with F=-rf): judged as `rm -r`.
 */
function rmKind(args) {
  if (flagsOf(args).some((flag) => RECURSIVE_FLAG.test(flag))) return 'rm -r';
  const first = args.findIndex((word) => !word.startsWith('-'));
  const unread = flagsOf(args).some((flag) => EXPANSION.test(flag)) || args.some((word) => MANY_WORDS.test(word)) || (first !== -1 && first < args.length - 1 && WHOLE_EXPANSION.test(args[first]));
  return unread ? UNREAD_OPTIONS_RM : undefined;
}

/**
 * @param {string[]} args words after `rm`
 * @param {{cwd: string | null, project: string, vars: Map<string, string>, splitWords?: Set<string>, groupTargets?: string[], work?: {readings: number, spent: boolean}}} env the
 *   folder and variables of the segment; groupTargets are the branches of a glob group written after the rm (lib/bare-glob.mjs groupBranches);
 *   work is the line's budget (newWork), a fresh one when the caller has none
 * @returns {string | undefined} ask reason when a recursive rm targets something outside the project and the temp dirs (or an unknown variable)
 */
export function checkRm(args, { cwd, project, vars, splitWords, groupTargets = [], work = newWork(), maybeCwds = [] }) {
  if (work.spent) return TOO_COMPLEX_REASON;
  const rm = rmKind(args);
  if (rm === undefined) return undefined;
  const words = readingsWithin(work, [...withoutRedirects(args).filter((a) => !a.startsWith('-')), ...groupTargets], splitWords);
  if (words === null) return TOO_COMPLEX_REASON;
  const long = words.find((word) => word.length > MAX_TARGET_CHARS);
  if (long !== undefined) return destructive(`${rm} with a target too long to check (${long.length} characters, the guard reads up to ${MAX_TARGET_CHARS})`);
  if (words.some((word) => expandBraces(word) === null)) return destructive(`${rm} with a brace expansion that cannot be listed (check the targets by hand)`);
  const judged = words.flatMap(expandBraces).flatMap((target) => readingsOf(target, cwd, vars).map((reading) => ({ target, reading })));
  const outside = judged.find(({ target, reading }) => !insideProject(target, cwd, project, reading));
  if (outside !== undefined) return destructive(`${rm} outside the project (${shown(outside.target)})`);
  const heres = (cwd === null ? maybeCwds : [cwd]).filter((here) => here !== null); // an unknown folder: every folder the line may be in
  const whole = judged.find(({ target, reading }) => emptiesWholeFolder(target, { cwd, project, heres }, reading));
  return whole === undefined ? undefined : destructive(`${rm} that empties a whole folder (${shown(whole.target)}): the working directory itself, or a bare glob of it, the project root, home, a temp root or /`);
}
