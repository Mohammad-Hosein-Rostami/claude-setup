// Path rules for `rm -r`: is a target inside the project or a scratch area, and which variables hold what (the folder after a `cd`: lib/cd-folder.mjs).
// Scratch areas (owner FR6: own session temp folder, `cs-test-*` folders; no exemption on a line that may make links): lib/scratch-area.mjs.
// Exports: checkRm(args, {cwd, project, vars}) -> reason | undefined; MAX_TARGET_CHARS; MAX_LINE_READINGS; TOO_COMPLEX_REASON; newWork();
// PWD_TARGET; expandVars; shown(target) -> the target as a reason shows it; newScope(cwd, project) -> {vars, assigned};
// trackAssignments(scope, tokens, nextTokens); substituteKnownWords(tokens, scope); bashReadings(word, splitWords) (also read by
// lib/find-delete.mjs); nativePath, expandHome(target, vars), HOME_ASSIGNED; isUnder, sameFile (from lib/scratch-area.mjs); RECURSIVE_FLAG;
// withoutRedirects(args) (from lib/shell-words.mjs, read by lib/git-runs.mjs; shown comes from lib/verdict.mjs);
// DECLARERS (from lib/shell-words.mjs, also read by lib/git-run-values.mjs).
// An unquoted `$D` whose value has blanks is judged as one path (zsh) and as the words bash splits it into; `X[2]=v` makes X unknown.
// Variables are tracked in order within one command line and the LAST assignment wins (`D=$(mktemp -d); D=/etc` means /etc); on a line
// with a loop or a function a name written twice is unknown (lib/same-line-values.mjs, also for `VAR=$(mktemp -d TEMPLATE)`).
// A literal value is used as is, `VAR=$(mktemp -d)` (default location; the tokenizer turns it into MKTEMP_WORD, also with a path
// suffix `$(mktemp -d)/..` and in backticks) stands for one directory inside the temp dir (a template in a scratch area: its own
// folder; neither when the line may make mktemp fail, which leaves the name empty), `D+=x` appends, and any other value is unknown. `..` is resolved lexically after substitution, so `$D/..` is outside the mktemp directory. A target deeper than
// `$D/x` (`$D/x/y`, `$D/x/`) is let run only while the line holds no command that may make a link there (lib/scratch-area.mjs).
// Brace expansion in targets (`{/,x}`) is expanded first; one that cannot be listed asks.
// `$(git rev-parse --show-toplevel)` counts as the project root from a directory inside the project (`rm -rf "$(git rev-parse --show-toplevel)/dist"`).
// Only a recursive rm asks about an unknown or outside target; `rm -f x` of one file is not judged here. An rm whose options the guard
// cannot read counts as recursive (lib/rm-kind.mjs rmKind; its reasons say "rm that may be recursive", not "rm -r"): `-$X`, `"$@"`, `"${a[@]}"`, or one variable where the
// options stand (`rm $F ~`).
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
// Invariants: pure apart from reading homedir()/tmpdir() and, for a target outside the project, the real paths of its folders
// (realpath, lstat and a folder listing only, cached per line in the work budget; nothing is ever written).
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { globbedFolder } from './bare-glob.mjs';
import { expandBraces } from './braces.mjs';
import { RECURSIVE_FLAG, rmKind } from './rm-kind.mjs';
import { defaultMktempDir, isMadeValue, madeFolderOf, restInMadeFolder, sameLineValues, templateFolder, templateOf } from './same-line-values.mjs';
import { claimScratchDelete, deletedPath, followsNoFolderBelow, inScratchArea, isUnder, linkState, runsInOrder, sameFile } from './scratch-area.mjs';
import { DECLARERS, GIT_TOPLEVEL_WORD, MKTEMP_WORD, QUOTED_MARK, backtickAssignedNames, withoutRedirects } from './shell-words.mjs';
import { MAX_COMMAND_CHARS, destructive, shown } from './verdict.mjs';

export { DECLARERS, RECURSIVE_FLAG, isUnder, runsInOrder, sameFile, shown, withoutRedirects };
const SAFE_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const GIT_BASH_DRIVE_ROOT = /^\/[a-zA-Z]$/;
const VAR_PREFIX = /^\$\{?(\w+)\}?(?=\/|$)/;
export const PWD_TARGET = /^\$(?:PWD|\{PWD\})(?=\/|$)/; // `$(pwd)` and a backtick pwd reach here as `$PWD` (lib/shell-words.mjs)
const MKTEMP_NAME = MKTEMP_WORD.slice(1);
const ANY_VAR = /\$\{(\w+)\}|\$(\w+)/g;
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const SUBSCRIPT_ASSIGNMENT = /^([A-Za-z_]\w*)\[[^\]]*\]\+?=/; // `X[2]=v`: zsh changes part of a scalar, so its value is no longer known
const BLANKS = /[ \t\n]+/; // where bash splits an unquoted variable's value into words (the default IFS)
// `-rf`, `--recursive`: what an option word from a variable may hold and still be read (N5); one still holding `$` is judged by lib/rm-kind.mjs
const PLAIN_OR_UNREAD_OPTION = /^-{1,2}[A-Za-z][A-Za-z-]*$|[$`]/;
/** Work budget for one rm target: PATH_MAX is 4096 on Linux and 1024 on macOS, so a longer word is no path a real command names. */
export const MAX_TARGET_CHARS = 4096;
/** Work budget for one command line: the target readings the rm rule judges, over both parsers and every wrapped or nested rm. An unquoted
 * variable of thousands of words, used thousands of times, has millions: it kept the hook busy past its timeout (an ordinary line has a handful). */
export const MAX_LINE_READINGS = 20000;
/** The other half of the budget: the characters the line's own variables may be filled in with, over both parsers. Every rule reads the
 * filled-in words, so a long value used thousands of times made each rule scan tens of megabytes. Far above any line someone writes. */
export const MAX_LINE_EXPANDED_CHARS = 4 * MAX_COMMAND_CHARS;
export const TOO_COMPLEX_REASON = 'command too complex to check (its rm targets, or its commands after cd in nested scripts, are more than the guard reads); '
  + 'read it before allowing';
/**
 * @param {unknown} [sessionId] the hook input's session_id: whose scratch folder is free (lib/scratch-area.mjs validates it)
 * @returns {{readings: number, expanded: number, spent: boolean, realPaths: Map<string, string | null>, sessionId: unknown}} a fresh budget for
 *   one line, spent once either count ran out (the line then asks); realPaths caches deletedPath's reads, linkStates (lib/scratch-area.mjs) the links.
 */
export const newWork = (sessionId) => ({ readings: 0, expanded: 0, spent: false, realPaths: new Map(), sessionId });
/**
 * Git Bash paths (`/c/Users/x`) -> `c:/Users/x` on Windows; unchanged elsewhere. A bare drive (`/c`) is the drive ROOT, `c:/`: a plain
 * `c:` means "the current folder on drive c" to Windows, so `cd /c` would look like a cd that did not move.
 */
export const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?:\/|$)/, '$1:/') : p);

/** The key trackAssignments sets in a scope's `vars` once the line assigns HOME (no variable can be named `~`). */
export const HOME_ASSIGNED = '~';
/**
 * `~`, `~/x`, `$HOME`, `${HOME}` -> the home directory. Other words are unchanged, and so is every word once the line assigned HOME
 * (`HOME=/srv; cd ~`): the shell then reads `~` from the new value, so the word stays unknown (X4).
 */
export const expandHome = (target, vars) => (vars?.has(HOME_ASSIGNED) ? target : target.replace(HOME_PREFIX, homedir()));

/** $HOME, `/`, a drive root (`C:\`, `/c/`) are never "the project": a session started there would allow rm -r anywhere. */
function isBroadRoot(project) {
  const path = resolve(nativePath(project));
  return sameFile(path, parse(path).root) || sameFile(path, resolve(homedir())) || GIT_BASH_DRIVE_ROOT.test(path);
}

/**
 * Variable state for one command line: `vars` maps names to known values (`$TMPDIR`, `$CLAUDE_PROJECT_DIR`, `$PWD` when the directory is
 * known, the plain `$(mktemp -d)` stand-in unless the line may make that mktemp fail, then each literal assignment seen); `assigned` the
 * names the command assigns; `unknown` those it assigns from a backtick (the parsers lose the value); `sameLine` its mktemp facts (lib/same-line-values.mjs).
 */
export function newScope(cwd, project, command = '', work = newWork()) {
  const sameLine = sameLineValues(command);
  const vars = new Map([['TMPDIR', tmpdir()], ['CLAUDE_PROJECT_DIR', project], ...(sameLine.plainMktempCounts ? [[MKTEMP_NAME, defaultMktempDir()]] : [])]);
  if (cwd !== null) vars.set('PWD', cwd);
  return { vars, assigned: new Set(), unknown: backtickAssignedNames(command), sameLine, splitWords: new Set(), work };
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

/** The value a `NAME=value` word gives ($HOME filled in anywhere: `F="-T $HOME/k"`), or undefined when it cannot be known (`$(...)` other than the mktemp stand-in). */
function valueOf(raw, vars) {
  if (raw === '$' || raw === '`') return undefined; // a bare `$(`/backtick: the value is another command's output
  const value = expandVars(expandHome(raw, vars), vars).replace(/\$(?:HOME|\{HOME\})(?!\w)/g, (home) => (vars.has(HOME_ASSIGNED) ? home : homedir()));
  return /[$`]/.test(value) ? undefined : value;
}

/**
 * Updates `vars` for assignments in one segment (a bare `NAME=x` segment or `export NAME=x`), `unset`, `read`. Call after the
 * segment was checked. Names that become unknown are removed, so a later `$NAME` target is unknown.
 * @param {{vars: Map<string, string>, assigned: Set<string>, unknown?: Set<string>, sameLine?: ReturnType<typeof sameLineValues>,
 *   work?: ReturnType<typeof newWork>}} scope tracked values (modified); names in unknown, and those sameLine calls unstable, are never known
 * @param {string[]} tokens words of this segment
 */
export function trackAssignments({ vars, assigned, unknown = new Set(), sameLine = sameLineValues(''), work = newWork() }, tokens) {
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
    if (name === 'HOME') vars.set(HOME_ASSIGNED, '');
    const template = templateOf(sameLine, name, raw); // `D=$(mktemp -d T)` (lib/same-line-values.mjs)
    const added = template !== undefined ? templateFolder(nativePath(template), work) : valueOf(raw, vars);
    const value = append && added !== undefined ? (vars.has(name) ? vars.get(name) + added : undefined) : added; // `D+=x` extends the old value
    if (value === undefined || unknown.has(name) || sameLine.unstable(name)) vars.delete(name);
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
    if (work.spent || !assigned.has(name) || !vars.has(name) || isMadeValue(vars.get(name), work)) return whole;
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
const expandedTarget = (rawTarget, cwd, project, vars) => expandVars(expandHome(expandToplevel(rawTarget, cwd, project), vars), vars);

/**
 * True when the target is inside the project (as written) or in a scratch area (as deleted: deletedPath, inScratchArea). `cwd` is null when
 * an earlier `cd` could not be resolved: then only absolute targets can be judged. `known` is the line's real-path cache (newWork),
 * `links` what this reading of the line may make links with (lib/scratch-area.mjs linkState), `work` the line's budget (its session id and
 * the folders its `mktemp -d` made), `inOrder` whether this delete runs in order (lib/scratch-area.mjs runsInOrder).
 */
function insideProject(rawTarget, { cwd, project, known, links, work, inOrder }, vars) {
  const target = expandedTarget(rawTarget, cwd, project, vars);
  if (target.startsWith('~') || target.includes('$')) return false;
  const native = nativePath(target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? project, native);
  const written = isAbsolute(native) ? native : `${cwd ?? project}${sep}${native}`;
  // `$D/..` and `$D/../x` leave the unique directory mktemp made, so they only count as safe while they stay inside it
  const rest = restInMadeFolder({ target, abs, written }, work);
  if (rest !== undefined) return rest !== null && (followsNoFolderBelow(rest) || claimScratchDelete(links, target, inOrder));
  if (!isBroadRoot(project) && isUnder(project, abs)) return true;
  const deleted = deletedPath(written, known);
  return deleted !== null && inScratchArea(deleted, work.sessionId) && claimScratchDelete(links, target, inOrder);
}

/**
 * True when the target is the working directory itself, or a bare glob (also one below other bare globs, lib/bare-glob.mjs) whose folder is
 * the working directory, the project root, home, a temp root or a file-system root: removing it empties that whole folder even though every entry is
 * inside the project. Unknown targets return false (insideProject already asks about them). After a `cd` the guard could not follow
 * (`cwd` null) an absolute target is still judged, against the project root, home, the roots and `heres`, the folders the line may be in (lib/cd-folder.mjs);
 * a relative one was asked about already.
 */
function emptiesWholeFolder(rawTarget, { cwd, project, heres, work }, vars) {
  const target = expandedTarget(rawTarget, cwd, project, vars).replace(QUOTED_MARK, '');
  if (target.startsWith('~') || target.includes('$')) return false;
  const folder = globbedFolder(target);
  const native = nativePath(folder ?? target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? native, native);
  if (madeFolderOf(abs, work) !== undefined) return false; // a folder this line's `mktemp -d` made: nothing else is in it
  const isHere = heres.some((here) => sameFile(abs, resolve(nativePath(here))));
  if (folder === undefined) return isHere;
  const wholeFolders = [project, homedir(), ...SAFE_TEMP_ROOTS].map((whole) => resolve(nativePath(whole)));
  return isHere || wholeFolders.some((whole) => sameFile(abs, whole)) || sameFile(abs, parse(abs).root) || GIT_BASH_DRIVE_ROOT.test(abs);
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

const DOT_GLOB_PART = /(^|\/)\.[*?]+(?=\/)/; // `.*/proj`: before bash 5.2 the glob `.*` also matches `..`
/** A target, and when a folder part is a dot glob also the reading with that part as `..` (G7). */
const withParentReading = (target) => (DOT_GLOB_PART.test(target) ? [target, target.replace(new RegExp(DOT_GLOB_PART, 'g'), '$1..')] : [target]);
const WHOLE_FOLDERS = 'the project root, home, a temp root or /';
const splitAtBlanks = (word) => word.split(BLANKS).filter(Boolean);
/**
 * The first option word an unquoted variable gave the rm that holds more than option letters (`F=-rf,/x; rm $F`), or undefined. Another IFS
 * would split it into options and targets (`IFS=,`), so it is not read as one option: the rm asks (N5; lib/shell-hazards.mjs asks for IFS itself).
 */
const unreadOption = (args, bareWords, splitWords) => args.filter((word) => bareWords.has(word))
  .flatMap((word) => (splitWords?.has(word) ? splitAtBlanks(word) : [word])).find((piece) => piece.startsWith('-') && !PLAIN_OR_UNREAD_OPTION.test(piece));
/**
 * @param {string[]} args words after `rm`
 * @param {{cwd: string | null, project: string, vars: Map<string, string>, splitWords?: Set<string>, bareWords?: Set<string>, groupTargets?: string[],
 * work?: {readings: number, spent: boolean, realPaths?: Map<string, string | null>}, parse?: unknown}} env the
 *   folder and variables of the segment; bareWords are the command's words with a `$NAME` outside quotes; groupTargets are the branches of a
 *   glob group written after the rm (lib/bare-glob.mjs groupBranches); work is the line's budget (newWork), a fresh one when the caller has none;
 *   parse is the parser of this reading of the line (lib/scratch-area.mjs linkState keeps the links each reading may make apart); inOrder: the
 *   rm surely finishes before any later command of the line starts (lib/scratch-area.mjs runsInOrder; false, the default, when unknown)
 * @returns {string | undefined} ask reason when a recursive rm targets something outside the project and the temp dirs (or an unknown variable)
 */
export function checkRm(args, { cwd, project, vars, splitWords, bareWords = new Set(), groupTargets = [], work = newWork(), maybeCwds = [], parse, inOrder = false }) {
  if (work.spent) return TOO_COMPLEX_REASON;
  const odd = unreadOption(args, bareWords, splitWords);
  if (odd !== undefined) return destructive(`rm with an option word from a variable that holds more than option letters (${shown(odd)}), with targets the guard cannot read; check them by hand`);
  // bash splits an unquoted variable's value at blanks: `F='-rf /'; rm $F` is `rm -rf /` (N5), so its options are read from the pieces
  const rm = rmKind(args.flatMap((word) => (splitWords?.has(word) ? splitAtBlanks(word) : [word])), bareWords);
  if (rm === undefined) return undefined;
  const operand = (word) => (!word.startsWith('-') ? [word] : splitWords?.has(word) ? splitAtBlanks(word).filter((piece) => !piece.startsWith('-')) : []);
  const words = readingsWithin(work, [...withoutRedirects(args).flatMap(operand), ...groupTargets], splitWords);
  if (words === null) return TOO_COMPLEX_REASON;
  const long = words.find((word) => word.length > MAX_TARGET_CHARS);
  if (long !== undefined) return destructive(`${rm} with a target too long to check (${long.length} characters, the guard reads up to ${MAX_TARGET_CHARS})`);
  if (words.some((word) => expandBraces(word) === null)) return destructive(`${rm} with a brace expansion that cannot be listed (check the targets by hand)`);
  const targets = words.flatMap(expandBraces).flatMap(withParentReading);
  const judged = targets.flatMap((target) => readingsOf(target, cwd, vars).map((reading) => ({ target, reading })));
  const place = { cwd, project, known: work.realPaths ?? new Map(), links: linkState(work, parse), work, inOrder };
  const outside = judged.find(({ target, reading }) => !insideProject(target, place, reading));
  if (outside !== undefined) return destructive(`${rm} outside the project (${shown(outside.target)})`);
  const heres = (cwd === null ? maybeCwds : [cwd]).filter((here) => here !== null); // an unknown folder: every folder the line may be in
  const whole = judged.find(({ target, reading }) => emptiesWholeFolder(target, { cwd, project, heres, work }, reading));
  if (whole === undefined) return undefined;
  return destructive(`${rm} that empties a whole folder (${shown(whole.target)}): the working directory itself, or a bare glob of it, ${WHOLE_FOLDERS}`);
}
