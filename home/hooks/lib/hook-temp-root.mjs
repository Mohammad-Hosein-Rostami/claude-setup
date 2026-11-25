// The per-user hook temp root that the post-edit hook's notice markers (lib/team-switch.mjs noticeOnce) live in.
// Exports: tempRoot(), checkedTempRoot().
// The root: `<os.tmpdir()>/claude-post-edit` when the temp folder is private to this user (owned by the uid, no group or other write bit:
// macOS's per-user TMPDIR, a test's own temp folder; Windows always, where %TEMP% is per user), else `claude-post-edit-<uid>` (Linux's
// shared /tmp): two names so the existing folder and the tests that build the old name keep working where the temp folder is private.
// checkedTempRoot() checks it before every use (POSIX): made 0700 when missing, opened without following a link or waiting, and kept only
// when it is a folder owned by this uid with no group or other write bit. One with group or other read or search bits only (0755, what
// earlier versions made) is tightened to 0700: nobody else could write it, so it holds nothing another user put there. One others may
// write is refused, not repaired. Refused: nothing is kept there and one stderr line per process says so.
// Invariants: every write fails silently (a hook must never block a tool call because the temp dir is unwritable).
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT_NAME = 'claude-post-edit';
const ROOT_MODE = 0o700;
const OTHERS_WRITE = 0o022;
const OTHERS_ANY = 0o077;
const IS_WINDOWS = process.platform === 'win32';
const ROOT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** True when the temp folder is this user's alone (owned by the uid, no group or other write bit); false when shared or unreadable. */
function privateTempFolder(dir) {
  try {
    const stat = statSync(dir);
    return stat.uid === process.getuid() && (stat.mode & OTHERS_WRITE) === 0;
  } catch {
    return false; // unreadable: treated as shared, so the root gets the uid name
  }
}

/**
 * Root of everything the post-edit hooks keep in the temp dir. Not checked: build a path with it only under a root checkedTempRoot()
 * already passed in this process, or call checkedTempRoot().
 * @returns {string} `<tmp>/claude-post-edit` where the temp folder is private (and on Windows), `<tmp>/claude-post-edit-<uid>` where shared
 */
export function tempRoot() {
  const dir = tmpdir();
  return IS_WINDOWS || privateTempFolder(dir) ? join(dir, ROOT_NAME) : join(dir, `${ROOT_NAME}-${process.getuid()}`);
}

/** Why the root at `root` may not be used, or null when it may (a 0755 one is tightened to 0700 on the opened descriptor). */
function rootProblem(root) {
  try {
    mkdirSync(root, { mode: ROOT_MODE });
  } catch (error) {
    if (error?.code !== 'EEXIST') return `not creatable (${error?.code ?? 'error'})`;
  }
  if (IS_WINDOWS) return lstatSync(root).isDirectory() ? null : 'not a folder'; // a link is not a directory to lstat; no uid, no mode bits
  let fd;
  try {
    fd = openSync(root, ROOT_OPEN_FLAGS);
  } catch (error) {
    if (error?.code !== 'ELOOP' && error?.code !== 'ENOTDIR') return `not openable (${error?.code ?? 'error'})`;
    return lstatSync(root).isSymbolicLink() ? 'a link' : 'not a folder'; // macOS gives ENOTDIR for a link opened with O_DIRECTORY
  }
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid()) return 'owned by another user';
    if (stat.mode & OTHERS_WRITE) return 'writable by other users';
    if (stat.mode & OTHERS_ANY) fchmodSync(fd, ROOT_MODE);
    return null;
  } finally {
    closeSync(fd);
  }
}

const refusedRoots = new Set();

/**
 * The temp root after its check (module header): the path to use, or null when it is refused. A refusal writes one warning line to
 * stderr per process and root, naming the root.
 * @returns {string | null}
 */
export function checkedTempRoot() {
  const root = tempRoot();
  let why;
  try {
    why = rootProblem(root);
  } catch (error) {
    why = `not checkable (${error?.code ?? 'error'})`;
  }
  if (why === null) return root;
  if (!refusedRoots.has(root)) {
    refusedRoots.add(root);
    process.stderr.write(`edit-log: hook temp folder refused, ${why}: nothing is kept there; remove it if it is yours: ${root}\n`);
  }
  return null;
}
