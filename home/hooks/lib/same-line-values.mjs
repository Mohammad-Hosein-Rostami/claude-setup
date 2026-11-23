// What a command line's own variables hold for the `rm -r` rule beyond the literal values lib/rm-paths.mjs tracks in order (spec X8, F2):
// the folders a `mktemp -d` of the line makes, and the names whose value cannot be known because the line writes them again in a loop or
// a function body. Read by lib/rm-paths.mjs (newScope, trackAssignments, insideProject).
// Exports: defaultMktempDir(); madeFolders(work) -> string[]; madeFolderOf(path, work) -> folder | undefined; isMadeValue(value, work);
// restInMadeFolder({target, abs, written}, work) -> rest | null | undefined; sameLineValues(line) -> {templates: Map<name, {template,
// text}>, unstable(name) -> boolean}; templateOf(sameLine, name, raw) -> template | undefined; templateFolder(template, work) -> folder | undefined.
// `NAME=$(mktemp -d TEMPLATE)` (also in double quotes) counts only when all of these hold on the raw text (an allowlist, P4): it is a
// statement of its own (STATEMENT_START, STATEMENT_END); TEMPLATE is
// an absolute literal path (no `$`, quote, glob, `~`, blank or backslash) whose last part ends in at least three `X`; the line writes NAME
// nowhere else (the write count of lib/git-run-values.mjs lineFacts); the line holds no loop and no function (the assignment could run more than once). The
// folder it makes then counts as one the line made itself, as the plain `$(mktemp -d)` does, when the template's folder is there now and
// the template lies in a scratch area (lib/scratch-area.mjs): `rm -rf $D` and `rm -rf $D/x` run unasked even after a command that may
// make links. On a line that holds a loop or a function, a name the line writes more than once is never known (`D=x; for ...; do rm -rf
// $D; D=/etc; done` deletes /etc on the second pass).
// Invariants: reads the file system only through lib/scratch-area.mjs (realpath, lstat); the only state it changes is work.mktempDirs.
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { inScratchArea, isUnder, realFolder } from './scratch-area.mjs';

const MKTEMP_DIR = 'mktemp-variable'; // stands for the one folder a plain `$(mktemp -d)` makes in the temp folder
const TEMPLATE_PATH = String.raw`\/[A-Za-z0-9._\/@%+,:-]*X{3,}`; // mktemp replaces the trailing X (GNU wants at least three)
// a statement of its own in this shell: at the line start or after `;`, a newline, `&&` or `||` (not in a pipe, `( )` or after `&`, where
// bash assigns in a subshell), maybe after export|local|declare|typeset|readonly, and followed by the same (`D=$(...) cmd` sets D for cmd only)
const STATEMENT_START = String.raw`(?:^|[;\n]|&&|\|\|)[ \t]*(?:(?:export|local|declare|typeset|readonly)[ \t]+)?`;
const STATEMENT_END = String.raw`(?=[ \t]*(?:[;\n]|&&|\|\||$))`;
const MKTEMP_TEMPLATE = new RegExp(
  String.raw`${STATEMENT_START}([A-Za-z_]\w*)=("?)(\$\(mktemp[ \t]+-d[ \t]+(${TEMPLATE_PATH})[ \t]*\))\2${STATEMENT_END}`, 'g');
// a loop or function word in command position, or `()`: then a value assigned once may still be assigned again on a later pass
const LOOP_OR_FUNCTION = /(?:^|[\s;&|(){}`])(?:for|while|until|select|repeat|foreach|function)(?=[\s;(]|$)|\(\s*\)/;

/** The folder a plain `$(mktemp -d)` of the line stands for (lib/shell-words.mjs MKTEMP_WORD). */
export const defaultMktempDir = () => join(tmpdir(), MKTEMP_DIR);

/**
 * @param {{mktempDirs?: Set<string>}} work the line's budget (lib/rm-paths.mjs newWork)
 * @returns {string[]} every folder a `mktemp -d` of this line made: the plain one, then each template's (templateFolder)
 */
export const madeFolders = (work) => [defaultMktempDir(), ...(work.mktempDirs ?? [])];

/**
 * @param {string} path an absolute path
 * @param {{mktempDirs?: Set<string>}} work the line's budget
 * @returns {string | undefined} the folder a `mktemp -d` of this line made that the path is or lies in
 */
export const madeFolderOf = (path, work) => madeFolders(work).find((folder) => path === folder || isUnder(folder, path));

/** True when a variable's value is, or starts with, a folder a `mktemp -d` of this line made (lib/rm-paths.mjs leaves such `$D` as written). */
export const isMadeValue = (value, work) => typeof value === 'string' && madeFolders(work).some((folder) => value.startsWith(folder));

/**
 * Where an rm target stands to a folder a `mktemp -d` of this line made.
 * @param {{target: string, abs: string, written: string}} path the target with its variables filled in, resolved, and absolute as written
 * @param {{mktempDirs?: Set<string>}} work the line's budget
 * @returns {string | null | undefined} the rest of the written target after that folder (lib/scratch-area.mjs followsNoFolderBelow reads
 *   it); null when the target names the folder but `..` leads out of it (`$D/..`); undefined when no such folder is involved
 */
export function restInMadeFolder({ target, abs, written }, work) {
  const named = madeFolders(work).find((folder) => target.startsWith(folder));
  if (named !== undefined && abs !== named && !isUnder(named, abs)) return null;
  const made = madeFolderOf(abs, work);
  if (made === undefined) return undefined;
  return written.startsWith(made) ? written.slice(made.length) : written;
}

const MKTEMP_SPLIT_VALUE = '$'; // `D=$(mktemp -d T)` unquoted: the parsers end the value where the substitution starts
/**
 * @param {ReturnType<typeof sameLineValues>} sameLine the line's templates
 * @param {string} name an assigned name
 * @param {string} raw its value as the parser gave it: `$` (unquoted) or the `$(...)` text (double-quoted)
 * @returns {string | undefined} the template, when this assignment is the line's `NAME=$(mktemp -d TEMPLATE)`
 */
export function templateOf(sameLine, name, raw) {
  const entry = sameLine.templates.get(name);
  return entry !== undefined && (raw === MKTEMP_SPLIT_VALUE || raw === entry.text) ? entry.template : undefined;
}

/**
 * The line's `mktemp -d` templates and the names it may assign again (see the header).
 * @param {string} line one command line as written
 * @returns {{templates: Map<string, {template: string, text: string}>, unstable: (name: string) => boolean}} templates by name, with the
 *   `$(...)` text as written; unstable is true for a name written more than once on a line with a loop or a function
 */
export function sameLineValues(line) {
  const writtenAgain = writtenMoreThanOnce(line);
  const loopy = LOOP_OR_FUNCTION.test(line);
  const templates = new Map();
  for (const [, name, , text, template] of loopy ? [] : line.matchAll(MKTEMP_TEMPLATE)) {
    if (!writtenAgain(name)) templates.set(name, { template, text });
  }
  return { templates, unstable: (name) => loopy && writtenAgain(name) };
}

// The write count of lib/git-run-values.mjs lineFacts, with its two patterns: importing that module here would close an import cycle
// (git-runs.mjs -> rm-paths.mjs -> this file -> git-run-values.mjs -> git-runs.mjs) that leaves COMMAND_ENV uninitialised at load.
// A name standing outside a `$NAME` / `${NAME...}` reference (an assignment, `read NAME`, `for NAME`, also a path part) counts as a write;
const NAME_WRITE = /(?<![\w$]|\$\{)([A-Za-z_]\w*)(?!\w)|\$\{([A-Za-z_]\w*):{0,2}=/g;
// a write whose variable name is itself a variable (`printf -v "$N"`, `export "$N=x"`) may write any name
const UNKNOWN_TARGET = /\bprintf?\s+(?:-\S+\s+)*-v\s*["']?\$|\b(?:read|mapfile|readarray|getopts|export|declare|typeset|local|readonly)\b(?:\s+-\S+)*\s+["']?\$/;

/** @returns {(name: string) => boolean} true for a name the line may write more than once (any name after an UNKNOWN_TARGET write) */
function writtenMoreThanOnce(line) {
  const counts = new Map();
  for (const [, bare, defaulted] of line.matchAll(NAME_WRITE)) counts.set(bare ?? defaulted, (counts.get(bare ?? defaulted) ?? 0) + 1);
  const anyName = UNKNOWN_TARGET.test(line);
  return (name) => anyName || (counts.get(name) ?? 0) > 1;
}

/**
 * Where a `mktemp -d TEMPLATE` makes its folder, as a real path, when the template's folder is there now and the template lies in a
 * scratch area; it is then noted on the line's budget as a folder the line made (madeFolders).
 * @param {string} template the template as a native absolute path
 * @param {{realPaths: Map<string, string | null>, sessionId: unknown, mktempDirs?: Set<string>}} work the line's budget (modified)
 * @returns {string | undefined} the folder (its last part still the template's), or undefined when it does not count
 */
export function templateFolder(template, work) {
  const folder = realFolder(dirname(template), work.realPaths ?? new Map());
  const made = folder === null ? undefined : join(folder, basename(template));
  if (made === undefined || !inScratchArea(made, work.sessionId)) return undefined;
  work.mktempDirs ??= new Set();
  work.mktempDirs.add(made);
  return made;
}
