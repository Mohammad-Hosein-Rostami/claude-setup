// Per-session state files of the Bash guard, safe against planted links and special files. lib/allowed-literals.mjs (guard-allowed) and
// lib/bounce-once.mjs (guard-bounced) each keep one small JSON file per session id in their own folder under ~/.claude/state.
// Exports: isSessionId(session), readSessionFile(dir, session, maxBytes) -> text | null | undefined,
// writeSessionFile(dir, session, text, options?) -> boolean.
// Why: a Bash command can put a link, a FIFO or a folder where these files live. The hook must never follow a link, hang on a FIFO, or
// change or delete anything outside its own folder.
// Invariants:
// - Before any read, write or cleanup, lstat checks that the folder is a real folder and the session file a regular file, both owned by
//   this user (Windows has no owner check). A link, a FIFO, a socket, a device, a folder where the file should be, a file where the folder
//   should be, or another owner makes the store unusable: no read, no write, no cleanup, and the caller asks as if nothing were stored.
// - A read opens with O_NOFOLLOW and O_NONBLOCK (POSIX) and checks the open handle again (fstat), so a path swapped after the lstat is
//   caught and a FIFO never blocks. A write creates a new temp file (random name, O_EXCL, O_NOFOLLOW, 0600) and renames it over the
//   session file only while the folder is still the one checked. A missing folder is created 0700; an existing one keeps its mode.
// - Cleanup (on each write unless the caller passes { sweep: false }, which a store of long-lived history uses) removes only
//   this user's regular files older than 7 days, directly in the checked folder, whose names match STORE_FILE (a
//   session file or its temp file). It never recurses and never follows a link. Node has no unlinkat, so the folder is checked again
//   (same device and inode) right before each delete: only a folder swapped inside that gap could lose such a file.
// - Nothing here throws.
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STORE_FILE = /^[A-Za-z0-9_-]{1,100}\.json(?:\.[0-9a-f]{1,16}\.tmp)?$/; // <session>.json, or a temp file a crash left (pid or random hex)
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_NAME_BYTES = 8; // 16 hex characters: a temp name nobody can guess ahead
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // POSIX only, like O_NONBLOCK; Windows has neither (and no FIFO to block on)
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | NO_FOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

/**
 * @param {unknown} session the hook's session id
 * @returns {boolean} true when it is safe as a file name: [A-Za-z0-9_-]{1,100}
 */
export const isSessionId = (session) => typeof session === 'string' && SESSION_ID.test(session);

const ownedByMe = (stats) => typeof process.getuid !== 'function' || stats.uid === process.getuid();
const isPrivateFolder = (stats) => stats.isDirectory() && ownedByMe(stats); // from lstat: a link is never a directory
const isPrivateFile = (stats) => stats.isFile() && ownedByMe(stats);
const sameNode = (first, second) => first.dev === second.dev && first.ino === second.ino;

/** @returns {import('node:fs').Stats | null} lstat of path, or null when nothing is there; any other error throws */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} dir the store folder
 * @param {string} session the session id (see isSessionId)
 * @param {number} maxBytes a bigger file was not written by the guard, so it is not trusted
 * @returns {string | null | undefined} the file's text; null when the folder or the file does not exist yet; undefined when the id is
 *   bad, the store is unusable (see the header), the file is too big or the read failed
 */
export function readSessionFile(dir, session, maxBytes) {
  try {
    const folder = isSessionId(session) ? lstatOrNull(dir) : undefined;
    if (folder === null) return null;
    if (folder === undefined || !isPrivateFolder(folder)) return undefined;
    const path = join(dir, `${session}.json`);
    const file = lstatOrNull(path);
    if (file === null) return null;
    return isPrivateFile(file) && file.size <= maxBytes ? readOpened(path, maxBytes) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads path through a handle that is checked again (a FIFO or link swapped in after the lstat is caught here, never waited on). */
function readOpened(path, maxBytes) {
  const fd = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (!isPrivateFile(opened) || opened.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(opened.size + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > opened.size ? undefined : buffer.toString('utf8', 0, length); // more than fstat said: written in place, not by the guard
  } finally {
    closeSync(fd);
  }
}

/**
 * Stores text as dir/<session>.json: creates the folder (0700) when missing, removes the store's own files older than 7 days, then writes
 * a new temp file (0600) and renames it over the session file, so no reader ever sees half a file.
 * @param {string} dir the store folder
 * @param {string} session the session id (see isSessionId)
 * @param {string} text the new content
 * @param {{sweep?: boolean}} [options] sweep: remove this folder's files older than 7 days first (default true); false for a
 *   store whose files must outlive an idle week
 * @returns {boolean} true when stored; false when the id is bad, the store is unusable or the write failed
 */
export function writeSessionFile(dir, session, text, { sweep = true } = {}) {
  try {
    const folder = isSessionId(session) ? privateFolder(dir) : undefined;
    const existing = folder === undefined ? undefined : lstatOrNull(join(dir, `${session}.json`));
    if (existing === undefined || (existing !== null && !isPrivateFile(existing))) return false;
    if (sweep) pruneOld(dir, folder, Date.now());
    return replaceFile(dir, folder, `${session}.json`, text);
  } catch {
    return false; // the folder could not be made or checked, or the write failed: not stored
  }
}

/** @returns {import('node:fs').Stats | undefined} the store folder (made 0700 when missing) when it is a real folder of this user */
function privateFolder(dir) {
  if (lstatOrNull(dir) === null) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const folder = lstatSync(dir);
  return isPrivateFolder(folder) ? folder : undefined;
}

/** Removes this store's own old files (see the header), each entry on its own: one that vanished or is busy must not stop the rest. */
function pruneOld(dir, folder, now) {
  for (const name of readdirSync(dir).filter((entry) => STORE_FILE.test(entry))) {
    try {
      const path = join(dir, name);
      const entry = lstatSync(path);
      const old = isPrivateFile(entry) && now - entry.mtimeMs > MAX_AGE_MS;
      if (old && sameNode(lstatSync(dir), folder)) unlinkSync(path); // the folder again, right before the delete: Node has no unlinkat
    } catch {
      // best effort: the entry vanished or cannot be removed; the next write tries again
    }
  }
}

/** Writes a new temp file and renames it over dir/name while dir is still the checked folder; the temp file never stays behind. */
function replaceFile(dir, folder, name, text) {
  const temp = join(dir, `${name}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`);
  writeNewFile(temp, text);
  try {
    if (!sameNode(lstatSync(dir), folder)) return false; // the folder was swapped during the write: store nothing
    renameSync(temp, join(dir, name));
    return true;
  } finally {
    rmSync(temp, { force: true }); // after the rename nothing is left at that name
  }
}

/** Creates path as a new 0600 file (O_EXCL: never an existing file or link) holding text; a failed write removes it again. */
function writeNewFile(path, text) {
  const fd = openSync(path, CREATE_FLAGS, FILE_MODE);
  let written = false;
  try {
    fchmodSync(fd, FILE_MODE); // the umask may have narrowed the mode given to open
    writeFileSync(fd, text);
    written = true;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}
