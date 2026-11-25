// Shared reads for the hook libs: how a file's start is read safely, and how the nearest git root and its git folder are found
// without running git.
// - readFileHead: the start of a regular file through a handle checked again after the open (agent-file-walk.mjs reads agent files
//   with it).
// - nearestGitEntry, gitDirOf, sharedGitDir, isInside, MAX_PARENT_LEVELS: the nearest folder at or above a path holding an entry
//   named exactly `.git` (at most MAX_PARENT_LEVELS up), the git folder it stands for, and the folder a linked worktree shares
//   (agent-folders.mjs, project-note-key.mjs, project-setup-scan.mjs, format-trust.mjs).
// No program ever runs: a `.git` folder is the git folder; a `.git` file is followed to its `gitdir:` (and a linked worktree's
// `commondir`); a `.git` link, FIFO or device, or a UNC or device path in a git file, gives none. Git files are read only as regular
// files (never through a link, a FIFO never blocks), only up to their cap, and never printed.
// Exports: readFileHead(path, maxBytes, flags?) -> text | undefined, isInside(path, project), nearestGitEntry, gitDirOf, sharedGitDir,
// MAX_PARENT_LEVELS. Invariants: bounded work (at most MAX_PARENT_LEVELS + 1
// folders looked at, reads of capped size).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const GIT_ENTRY = '.git';
export const MAX_PARENT_LEVELS = 64; // folders above cwd looked at for a `.git`: deeper than any real project
const MAX_PATH_FILE_BYTES = 4096; // a `.git` file or a `commondir` holds one path line
const GITDIR_PREFIX = 'gitdir: '; // the first line of a `.git` file; its path is relative to the folder holding the file
// A UNC or device path (\\host\share, //host/share): on Windows a lookup reaches the network and may send the user's credentials
const NETWORK_PATH = /^[\\/]{2}/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // a FIFO swapped in after a stat never blocks (POSIX only)
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // POSIX only; on Windows the lstat check before the open stands alone

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
