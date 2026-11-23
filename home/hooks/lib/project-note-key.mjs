// Which project a session folder belongs to, by a key that names it the same on every machine, and the personal notes kept
// under that key. Used by project-merge.mjs (the SessionStart and SubagentStart note).
// Exports: NOTE_MAX_BYTES, slugKey(text), urlKeys(url), repoIdentity(cwd, { git, home }), findNotes(keys, dirs).
// Key rules (layering spec section 3): the main checkout is the parent of `git rev-parse --git-common-dir` (so every worktree of
// one repository maps to it); the key comes from `remote.origin.url` with scheme, userinfo (`user:token@`), host, port, `.git`
// and `_git` segments removed, as the candidates `<seg-2>-<seg-1>` then `<seg-1>`; with no remote it is the main checkout's
// folder name; with no git it is the highest folder below HOME holding `.svn`, else the session folder's own name.
// Invariants (F1, F7): no part of a remote URL but its last two path segments, each made a slug, leaves this file, so a token
// in the URL never reaches the note. A key is never guessed: when git is missing, hangs, or fails while a `.git` entry is
// there (a broken repository), or the remote cannot be read, the identity has no keys (source 'none') and the note says so.
// A folder at or above HOME is no project (a session started in ~ gets no note). A UNC or device path (`\\host\share`,
// `//host/share`) is never followed (F6). Notes are read only as regular files with one name, directly in their folder, never
// through a link and never waiting on a FIFO, at most NOTE_MAX_BYTES each. Read-only; nothing here throws for a bad input.
import { lstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { isInside, nearestGitEntry, MAX_PARENT_LEVELS } from './agent-brief.mjs';
import { readPlainFileWith } from './plain-file.mjs';

export const NOTE_MAX_BYTES = 8192;
const KEY_MAX_CHARS = 64;
const NETWORK_PATH = /^[\\/]{2}/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const GIT_FOLDER = '.git';
const SVN_FOLDER = '.svn';
const AZURE_GIT_SEGMENT = '_git'; // Azure DevOps puts it between the project and the repository name
const NOT_FOUND_STATUS = 1; // `git config --get` exits 1 when the key is unset
const NONE = Object.freeze({ top: null, keys: Object.freeze([]), source: 'none' });

/** Path functions for a path git printed: Windows rules for a drive-letter path (git on Windows prints `C:/...`). */
const pathFor = (path) => (process.platform === 'win32' || WINDOWS_DRIVE.test(path) ? win32 : posix);

/**
 * A key made of plain letters and digits: NFKC, lower case, every other run of characters one `-`, at most KEY_MAX_CHARS.
 * @param {unknown} text - any name (untrusted).
 * @returns {string} the key; '' when nothing usable is left.
 */
export function slugKey(text) {
  if (typeof text !== 'string') return '';
  const slug = text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, KEY_MAX_CHARS).replace(/-+$/, '');
}

/** The path segments of a remote URL with scheme, userinfo, host and port gone, `.git` cut off and `_git` left out. */
function urlSegments(url) {
  let rest = url.trim().replace(/[?#][\s\S]*$/, '');
  const scheme = URL_SCHEME.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    rest = rest.slice(rest.lastIndexOf('@') + 1); // userinfo, even a malformed one holding `/`, is never kept
    const slash = rest.search(/[/\\]/);
    rest = slash < 0 ? '' : rest.slice(slash + 1); // host and port
  } else if (!WINDOWS_DRIVE.test(rest) && !rest.startsWith('/')) {
    rest = rest.slice(rest.lastIndexOf('@') + 1).replace(/^[^/\\:]+:/, ''); // scp form `user@host:path`
  }
  return rest.split(/[/\\]+/)
    .map((segment) => segment.replace(/\.git$/i, ''))
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== AZURE_GIT_SEGMENT);
}

/**
 * The key candidates of a remote URL: `<seg-2>-<seg-1>` then `<seg-1>` (one when the path has one segment).
 * @param {string} url - `remote.origin.url` (untrusted; may hold `user:token@`).
 * @returns {string[]} the slugs, most specific first; none when the URL has no usable path.
 */
export function urlKeys(url) {
  const segments = urlSegments(url);
  const last = segments.at(-1);
  const second = segments.length > 1 ? segments.at(-2) : undefined;
  const keys = [second === undefined ? '' : slugKey(`${second}-${last}`), slugKey(last)];
  return [...new Set(keys.filter(Boolean))];
}

/** Whether a `.git` entry may be at or above `cwd`: true also when that cannot be told (git's failure is then no "no repository"). */
function mayHaveGitEntry(cwd) {
  try {
    return nearestGitEntry(cwd) !== null;
  } catch {
    return true;
  }
}

/** The key of a folder name, as a one-key list (none when the name has no usable letters). */
const folderKeys = (folder) => [slugKey(pathFor(folder).basename(folder))].filter(Boolean);

/**
 * The identity from git: undefined when cwd is in no repository (the folder rules apply), else what git says.
 * @param {string} cwd - the session folder.
 * @param {(cwd: string, args: string[]) => { status: number | null, stdout?: string }} git - runs git (hardened, time-bound).
 */
function gitIdentity(cwd, git) {
  const found = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
  if (found.status !== 0) return mayHaveGitEntry(cwd) ? { ...NONE, reason: 'git-failed' } : undefined;
  const [commonDir = '', top = ''] = String(found.stdout).trim().split(/\r?\n/);
  if (commonDir === '' || top === '') return { ...NONE, reason: 'git-failed' };
  if (NETWORK_PATH.test(commonDir) || NETWORK_PATH.test(top)) return { ...NONE, reason: 'network' };
  const paths = pathFor(commonDir);
  const main = paths.basename(commonDir) === GIT_FOLDER ? paths.dirname(commonDir) : top; // a bare or submodule git folder: its worktree
  const remote = git(top, ['config', '--get', 'remote.origin.url']);
  if (remote.status === 0) {
    const keys = urlKeys(String(remote.stdout));
    if (keys.length > 0) return { top, keys, source: 'remote' };
  } else if (remote.status !== NOT_FOUND_STATUS) {
    return { top, keys: [], source: 'none', reason: 'git-failed' };
  }
  return { top, keys: folderKeys(main), source: 'folder' };
}

/** Whether `path` holds a real `.svn` folder (a link there does not count). */
function holdsSvn(path) {
  try {
    return lstatSync(join(path, SVN_FOLDER)).isDirectory();
  } catch {
    return false;
  }
}

/** The identity outside git: the highest folder below HOME (or up to the root) holding `.svn`, else the session folder itself. */
function folderIdentity(cwd, home) {
  let svnRoot = null;
  let folder = pathFor(cwd).resolve(cwd);
  for (let level = 0; level <= MAX_PARENT_LEVELS && folder !== home; level += 1) {
    if (holdsSvn(folder)) svnRoot = folder;
    const parent = pathFor(folder).dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return svnRoot === null ? { top: cwd, keys: folderKeys(cwd), source: 'cwd' } : { top: svnRoot, keys: folderKeys(svnRoot), source: 'svn' };
}

/**
 * Which project the session folder belongs to.
 * @param {unknown} cwd - the hook input's `cwd` (untrusted).
 * @param {{ git: (cwd: string, args: string[]) => { status: number | null, stdout?: string }, home: string }} deps - `git` runs
 *   git in a folder (hardened, killed after its timeout: then status is null); `home` is the user's home folder.
 * @returns {{ top: string | null, keys: string[], source: 'remote' | 'folder' | 'svn' | 'cwd' | 'none', reason?: 'home' |
 *   'network' | 'git-failed' }} `top`: the folder whose project files are read (the worktree root in git, the SVN root, else
 *   cwd), null when there is no project to read; `keys`: note key candidates, most specific first; `reason`: why there are no
 *   keys or no top ('home': the folder is HOME or above it; 'network': a UNC path, not followed; 'git-failed': git missing,
 *   hanging or failing in a repository, or the remote unreadable).
 */
export function repoIdentity(cwd, { git, home }) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return NONE; // no session folder: nothing to say
  if (NETWORK_PATH.test(cwd)) return { ...NONE, reason: 'network' };
  const identity = gitIdentity(cwd, git) ?? folderIdentity(cwd, home);
  if (identity.top !== null && isInside(home, identity.top)) return { ...NONE, reason: 'home' };
  return identity;
}

/** The first NOTE_MAX_BYTES of an open regular file as text, a character cut at the end dropped; and whether it was cut. */
function readNoteHead(fd, size) {
  const buffer = Buffer.alloc(Math.min(size, NOTE_MAX_BYTES));
  const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  const cut = size > NOTE_MAX_BYTES;
  return { text: cut ? text.replace(/\uFFFD$/, '') : text, cut };
}

/** The note `<dir>/<key>.md` when it is a regular file with one name (not a link, FIFO, device or hard link); else undefined. */
function readNote(dir, key) {
  const path = join(dir, `${key}.md`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink > 1) return undefined;
    return { path, ...readPlainFileWith(path, readNoteHead) };
  } catch {
    return undefined; // missing, swapped for a link (ELOOP) or unreadable: no note
  }
}

/** The real path of a notes folder (ours: install links it), or undefined when it is missing. */
function realFolder(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * The notes kept for a project: in each folder the first key candidate that has a note.
 * @param {string[]} keys - key candidates, most specific first (slugs only: no path separator can be in one).
 * @param {string[]} dirs - the notes folders in order (shared, then personal); a folder that is the same real folder as an
 *   earlier one is read once, under the earlier one.
 * @returns {{ key: string, dir: string, path: string, text: string, cut: boolean }[]} one per folder with a note; `path` is the
 *   file in the folder's real path; `cut`: the file is longer than NOTE_MAX_BYTES and only its start is in `text`.
 */
export function findNotes(keys, dirs) {
  const seen = new Set();
  const notes = [];
  for (const dir of dirs) {
    const real = realFolder(dir);
    if (real === undefined || seen.has(real)) continue;
    seen.add(real);
    for (const key of keys) {
      const note = slugKey(key) === key ? readNote(real, key) : undefined;
      if (note === undefined) continue;
      notes.push({ key, dir, ...note });
      break;
    }
  }
  return notes;
}
