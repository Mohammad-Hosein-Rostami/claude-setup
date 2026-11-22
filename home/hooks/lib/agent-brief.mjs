// What agent-model-guard.mjs reads for an Agent brief and the lines it adds to one. Each line is fixed text plus at most one path:
// nothing from the prompt, from STATUS.md or from a git file is ever copied into it.
// - Standing rules (every subagent type): a brief that does not contain "STATUS.md" gets one line before it naming the project's
//   STATUS.md, when that file's `## Standing rules` section has a non-empty line. The project is the nearest folder at or above cwd
//   (at most MAX_PARENT_LEVELS up) holding an entry named exactly `.git`, and its STATUS.md counts only when that repository's own
//   info/exclude has a line that, trimmed, is `STATUS.md` or `/STATUS.md`. info/exclude is local to this machine (no clone, package,
//   submodule content or commit brings it) and is where the owner hides work notes; a .gitignore or a global excludes file never
//   counts. A folder that only looks like a git folder (HEAD, objects, refs) is no repository. When the nearest `.git` does not list
//   STATUS.md there is no line: no folder further up is used. With no `.git` up to the filesystem root the project is cwd itself; a
//   walk that stops at MAX_PARENT_LEVELS gives no line. The agent reads the file itself.
// - Design lists (architect and Plan): a spec brief without "Reuse inventory" gets one line after it asking for the Reuse inventory
//   and Contract facts lists, with unstated product facts under "Unconfirmed". An analysis brief (its first non-empty line, trimmed,
//   starts with `analysis:`: the lead's own header, a question to analyse or compare, no lanes to build; architect.md "Analysis mode")
//   gets no such line. Only the first line counts, so pasted text deeper in a spec brief cannot switch the line off.
// Each line holds the text that suppresses it, so a brief is never extended twice. No program ever runs: a `.git` folder is the git
// folder; a `.git` file is followed to its `gitdir:` (and a linked worktree's `commondir`) only to read info/exclude; a `.git` link,
// FIFO or device, or a UNC or device path in a git file, gives no line. Git files are read only as regular files (never through a link,
// a FIFO never blocks), only up to their cap, and never printed. STATUS.md must be listed in its folder under exactly that name (on a
// case-insensitive disk `status.md` is another file) and be a regular file whose real path is inside the project; only its first
// MAX_STATUS_BYTES are read.
// Exports: withBriefLines(toolInput, cwd) -> input | null, readFileHead(path, maxBytes, flags?) -> text | undefined (the UI brief gate
// reads its matrix with it too), UNPRINTABLE, MAX_EXCLUDE_BYTES, and for agent-folders.mjs (which finds the same git root) isInside,
// nearestGitEntry, gitDirOf, sharedGitDir, MAX_PARENT_LEVELS. Invariants: withBriefLines never throws (any failure: null, the brief
// stays as it is); bounded work (at most MAX_PARENT_LEVELS + 1 folders looked at, two folder listings, four reads of capped size).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const STATUS_FILE = 'STATUS.md';
const GIT_ENTRY = '.git';
export const MAX_PARENT_LEVELS = 64; // folders above cwd looked at for a `.git`: deeper than any real project
const MAX_STATUS_BYTES = 1024 * 1024; // only the start of a longer STATUS.md is read; the rules section sits near the top
export const MAX_EXCLUDE_BYTES = 64 * 1024; // only the start of a longer info/exclude is read (a real one is a few lines)
const MAX_PATH_FILE_BYTES = 4096; // a `.git` file or a `commondir` holds one path line
const GITDIR_PREFIX = 'gitdir: '; // the first line of a `.git` file; its path is relative to the folder holding the file
const EXCLUDE_LINES = ['STATUS.md', '/STATUS.md']; // the info/exclude lines that mark STATUS.md as the owner's own note
// A UNC or device path (\\host\share, //host/share): on Windows a lookup reaches the network and may send the user's credentials
const NETWORK_PATH = /^[\\/]{2}/;
const RULES_HEADING = '## Standing rules';
const SECTION_END = /^#{1,2}[ \t]/; // the next heading of level 1 or 2 ends the section
const DESIGN_TYPES = ['architect', 'Plan'];
const REUSE_WORDS = 'Reuse inventory';
const ANALYSIS_BRIEF_PREFIX = 'analysis:'; // exact case, on the brief's first non-empty line only
const DESIGN_LISTS = 'Your spec must include "Reuse inventory" (the existing component, string or helper for each need, or none: <search used>) '
  + 'and "Contract facts" (every default, fallback, limit and enum the API schema states, and what the design does about each); '
  + 'list product facts the repo does not state under "Unconfirmed".';
export const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // control and format characters (bidi marks included) and line separators
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // a FIFO swapped in after a stat never blocks (POSIX only)
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // POSIX only; on Windows the lstat check before the open stands alone

/** @returns {boolean} true when the brief's first non-empty line, trimmed, starts with `analysis:` (an analysis brief, not a spec brief) */
const isAnalysisBrief = (prompt) => (prompt.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').trim().startsWith(ANALYSIS_BRIEF_PREFIX);

const rulesLine = (path) => `Read "## Standing rules" in ${path.replace(UNPRINTABLE, '')} first; where they differ from this brief, follow them.`;

/**
 * The start of a regular file, read through a handle that is checked again after the open.
 * @param {string} path the file (the caller has checked with stat that it is a regular file: a FIFO or device is never opened)
 * @param {number} maxBytes the most that is read
 * @param {number} [flags] the open flags (READ_FLAGS; the git files add O_NOFOLLOW)
 * @returns {string | undefined} its first maxBytes as UTF-8; undefined when the open handle is not a regular file
 * @throws {Error} when the file cannot be opened (the callers catch it)
 */
export function readFileHead(path, maxBytes, flags = READ_FLAGS) {
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes));
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** @returns {boolean} true when the real path `path` is the real folder `project` or inside it */
export function isInside(path, project) {
  const rest = relative(project, path);
  return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
}

/** @returns {boolean} true when path is a regular file inside project whose `## Standing rules` section has a non-empty line */
function hasStandingRules(path, project) {
  try {
    const real = realpathSync(path);
    if (!isInside(real, project) || !statSync(real).isFile()) return false; // a link out of the project, a folder, FIFO or device
    const lines = (readFileHead(real, MAX_STATUS_BYTES) ?? '').split(/\r?\n/);
    const start = lines.findIndex((line) => line.trimEnd() === RULES_HEADING);
    const section = start === -1 ? [] : lines.slice(start + 1);
    const end = section.findIndex((line) => SECTION_END.test(line));
    return (end === -1 ? section : section.slice(0, end)).some((line) => line.trim() !== '');
  } catch {
    return false; // missing or unreadable: no rules to point at
  }
}

/** @returns {import('node:fs').Stats | null} lstat of path; null when nothing is there (any other error throws: the caller fails open) */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** @returns {boolean} true when folder lists an entry named exactly `name` (a case-insensitive disk finds other spellings too) */
const listsEntry = (folder, name) => readdirSync(folder).includes(name);

/** @returns {string[] | undefined} the lines of a git file that is itself a regular file (a last line cut at maxBytes left out) */
function gitFileLines(path, maxBytes) {
  const stats = lstatOrNull(path);
  if (!stats?.isFile()) return undefined; // missing, a link, a folder, a FIFO or a device
  const lines = (readFileHead(path, maxBytes, READ_FLAGS | NO_FOLLOW) ?? '').split(/\r?\n/);
  return stats.size > maxBytes ? lines.slice(0, -1) : lines;
}

/**
 * @param {string} cwd the call's folder
 * @param {{ otherSpellings?: boolean }} [options] otherSpellings: also stop at a folder where the disk finds `.git` under another
 *   spelling (`.GIT` on a disk that ignores case). Claude Code finds its git root by a stat, so it stops there too.
 * @returns {{top: string, entry: import('node:fs').Stats, exact: boolean} | null | undefined} the nearest folder at or above cwd
 *   holding an entry named exactly `.git` (`exact`; with otherSpellings also one the disk finds under that name, `exact` false),
 *   with that entry's lstat; null when no folder up to the root has one; undefined when MAX_PARENT_LEVELS comes first
 */
export function nearestGitEntry(cwd, { otherSpellings = false } = {}) {
  let folder = resolve(cwd);
  for (let level = 0; level <= MAX_PARENT_LEVELS; level += 1) {
    const entry = lstatOrNull(join(folder, GIT_ENTRY));
    const exact = entry !== null && listsEntry(folder, GIT_ENTRY);
    if (exact || (entry !== null && otherSpellings)) return { top: folder, entry, exact };
    if (dirname(folder) === folder) return null;
    folder = dirname(folder);
  }
  return undefined;
}

/** @returns {string | undefined} the git folder a `.git` entry stands for: the folder itself, or the `gitdir:` of a `.git` file */
export function gitDirOf(top, entry) {
  if (entry.isDirectory()) return join(top, GIT_ENTRY);
  const first = entry.isFile() ? gitFileLines(join(top, GIT_ENTRY), MAX_PATH_FILE_BYTES)?.[0] : undefined; // a link or FIFO: none
  const target = first?.startsWith(GITDIR_PREFIX) ? first.slice(GITDIR_PREFIX.length).trim() : '';
  return target === '' || NETWORK_PATH.test(target) ? undefined : resolve(top, target);
}

/** @returns {string | undefined} the git folder a linked worktree shares with its main repository (its `commondir`), else gitDir itself; undefined for a network path */
export function sharedGitDir(gitDir) {
  const common = gitFileLines(join(gitDir, 'commondir'), MAX_PATH_FILE_BYTES)?.[0]?.trim() ?? '';
  if (NETWORK_PATH.test(common)) return undefined;
  return common === '' ? gitDir : resolve(gitDir, common);
}

/** @returns {boolean} true when the info/exclude of gitDir (of its main repository for a linked worktree) lists STATUS.md */
function excludesStatus(gitDir) {
  const shared = sharedGitDir(gitDir); // linked worktrees share info/exclude through the common folder
  if (shared === undefined) return false;
  if (!lstatOrNull(join(shared, 'info'))?.isDirectory()) return false; // missing, or a link that could lead anywhere
  return (gitFileLines(join(shared, 'info', 'exclude'), MAX_EXCLUDE_BYTES) ?? []).some((line) => EXCLUDE_LINES.includes(line.trim()));
}

/** @returns {string | undefined} the project's STATUS.md when it has standing rules and may be named (see the header) */
function standingRulesFile(cwd) {
  const found = nearestGitEntry(cwd);
  if (found === undefined) return undefined; // deeper than the walk goes: no line
  if (found !== null) {
    const gitDir = gitDirOf(found.top, found.entry);
    if (gitDir === undefined || !excludesStatus(gitDir)) return undefined; // the nearest .git decides: nothing further up is used
  }
  const project = found === null ? resolve(cwd) : found.top;
  const path = join(project, STATUS_FILE);
  return listsEntry(project, STATUS_FILE) && hasStandingRules(path, realpathSync(project)) ? path : undefined;
}

/**
 * The Agent input with the brief lines added (see the header): the rules line first, the design line last.
 * @param {unknown} toolInput the call's tool_input, or the copy the model routing made of it
 * @param {unknown} cwd the call's cwd; when it is not a string, this process's folder
 * @returns {object | null} a copy of toolInput with the longer prompt; null when no line applies or anything fails
 */
export function withBriefLines(toolInput, cwd) {
  try {
    const prompt = toolInput?.prompt;
    if (typeof prompt !== 'string') return null;
    const rules = prompt.includes(STATUS_FILE) ? undefined : standingRulesFile(typeof cwd === 'string' ? cwd : process.cwd());
    const design = DESIGN_TYPES.includes(toolInput.subagent_type) && !prompt.includes(REUSE_WORDS) && !isAnalysisBrief(prompt);
    if (rules === undefined && !design) return null;
    const lines = [...(rules === undefined ? [] : [rulesLine(rules)]), prompt, ...(design ? [DESIGN_LISTS] : [])];
    return { ...toolInput, prompt: lines.join('\n') };
  } catch {
    return null; // a reminder, not a rule: any failure leaves the brief as it is
  }
}
