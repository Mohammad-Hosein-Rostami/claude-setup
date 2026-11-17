// Small state files keyed by an id, safe against planted links and special files. The Bash guard's lib/allowed-literals.mjs
// (guard-allowed) and lib/bounce-once.mjs (guard-bounced) keep one JSON file per session id, the estimate tool its status line
// cache and calibration log (keyed by a STATUS.md hash; the log is written with sweep off, so it never expires), each in its
// own folder under ~/.claude/state.
// Exports: isSessionId(session), readSessionFile(dir, session, maxBytes) -> text | null | undefined,
// writeSessionFile(dir, session, text, options?) -> boolean, withSessionLock(dir, session, work, { lockFile }?) -> work's result | undefined.
// Why: a Bash command can put a link, a FIFO or a folder where these files live. The hook must never follow a link, hang on a FIFO, or
// change or delete anything outside its own folder.
// Invariants:
// - Before any read, write or cleanup, lstat checks that the folder is a real folder and the session file a regular file, both owned by
//   this user (Windows has no owner check). A link, a FIFO, a socket, a device, a folder where the file should be, a file where the folder
//   should be, or another owner makes the store unusable: no read, no write, no cleanup, and the caller asks as if nothing were stored.
// - A read opens with O_NOFOLLOW and O_NONBLOCK (POSIX) and checks the open handle again (fstat), so a path swapped after the lstat is
//   caught and a FIFO never blocks. A write creates a new temp file (random name, O_EXCL, O_NOFOLLOW, 0600) and renames it over the
//   session file only while the folder is still the one checked. A missing folder is created 0700; an existing one keeps its mode.
// - withSessionLock lets hooks that read and write one session file at the same moment take turns: the lock is a new file
//   <session>.lock (or the caller's lockFile name; O_EXCL, O_NOFOLLOW, 0600) in the checked folder holding `<pid> <random token>`.
//   After the turn it is removed only while it still holds that token. A lock is left behind, and removed, when it is dated more than
//   LOCK_CLOCK_SKEW_MS ahead (a clock change, a planted file), older than HELD_LOCK_MAX_MS, or older than STALE_LOCK_MS with its pid
//   gone or no `<pid> <token>` text (a killed holder, an older version's empty lock). One waiter at a time removes such a lock: it
//   first creates `<lock>.break` (O_EXCL, `<pid> <token>` text); a waiter that cannot create it treats the lock as busy, and the
//   breaker deletes that file when done (a `.break` file that is stale by the same rule is removed by the next waiter). Under it the
//   lock is read again and renamed aside only if it is still the one judged stale, so many waiters on one stale lock never delete a
//   lock another took. Left over: if the stale lock's own holder releases in the instant before the rename and two callers then take
//   the name, the lock moved aside is deleted (a lost mutual exclusion, not a crash). Worst wait a caller sees: LOCK_WAIT_MS (1 s),
//   after which it stores nothing; after a killed holder the next caller waits until that lock is STALE_LOCK_MS old (about 0.5 s).
//   Only a send that may be denied (a bounce or advice) takes the lock: a plain allow never touches the store. A link, FIFO or folder
//   at the lock's or the breaker's name makes the store unusable. Cleanup counts an old lock or breaker file as a store file too.
// - Cleanup (on each write unless the caller passes { sweep: false }, which a store of long-lived history uses) removes only
//   this user's regular files older than 7 days, directly in the checked folder, whose names match STORE_FILE (a
//   session file or its temp file). It never recurses and never follows a link. Node has no unlinkat, so the folder is checked again
//   (same device and inode) right before each delete: only a folder swapped inside that gap could lose such a file.
// - Nothing here throws.
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
// <session>.json, a temp file a crash left (pid or random hex), a lock, or a lock's breaker file
const STORE_FILE = /^[A-Za-z0-9_-]{1,100}\.(?:json(?:\.[0-9a-f]{1,16}\.tmp)?|lock(?:\.break)?)$/;
const LOCK_WAIT_MS = 1000; // the longest a hook waits for its turn; a turn (one read, one write) takes about 1 ms
const LOCK_PAUSE_MS = 2; // between two tries for the lock
const STALE_LOCK_MS = 500; // no turn takes this long: such a lock was left by a hook killed during its turn
const LOCK_CLOCK_SKEW_MS = 1000; // a lock's time may run this far ahead of the clock; further ahead, no running hook made it
// A lock whose process still runs is taken only past this age: the slowest turn measured is 185 ms (status.mjs on a 4 MiB
// STATUS.md), so a live pid on an older lock is a reused pid, not a holder.
const HELD_LOCK_MAX_MS = 5000;
const BREAKER_SUFFIX = '.break'; // `<lock>.break`: held by the one waiter that is removing a stale lock
const LOCK_TOKEN_BYTES = 16; // the random half of the lock's text `<pid> <32 hex>`: release compares it, so it never removes another's lock
const LOCK_TEXT_MAX_BYTES = 64; // `<pid> <32 hex>` is at most 43 bytes
const LOCK_OWNER = /^(\d{1,10}) [0-9a-f]{32}$/;
const LOCK_FILE_NAME = /^\.?[A-Za-z0-9_-]{1,100}\.[a-z-]{1,20}$/; // `<session>.lock`, `.<name>.status-lock`: one name, no path
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep
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

/**
 * Runs work while this caller alone holds the lock dir/<session>.lock (see the header), so a read and a write of the session file
 * inside work never drop a change another hook makes at the same moment.
 * @template T
 * @param {string} dir the store folder (made 0700 when missing)
 * @param {string} session the session id (see isSessionId)
 * @param {() => T} work the read and the write; it runs at most once
 * @param {{lockFile?: string}} [options] lockFile: the lock's file name in dir instead of `<session>.lock`, for a folder other tools
 *   write lock files into (status.mjs uses `.<name>.status-lock`); one name with an extension, no path (LOCK_FILE_NAME)
 * @returns {T | undefined} what work returned; undefined when the id or lock name is bad, the store is unusable, the lock stayed
 *   taken for LOCK_WAIT_MS, or anything failed
 */
export function withSessionLock(dir, session, work, { lockFile = `${session}.lock` } = {}) {
  try {
    const usable = isSessionId(session) && LOCK_FILE_NAME.test(lockFile);
    const folder = usable ? privateFolder(dir) : undefined;
    if (folder === undefined) return undefined;
    const lock = join(dir, lockFile);
    const token = `${process.pid} ${randomBytes(LOCK_TOKEN_BYTES).toString('hex')}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (takeLock(lock, token)) return runAndRelease(work, { dir, folder, lock, token });
      if (!clearStaleLock(dir, folder, lock)) return undefined;
      Atomics.wait(PAUSE, 0, 0, LOCK_PAUSE_MS);
    }
    return undefined; // still taken: nothing is stored, as for any other unusable store
  } catch {
    return undefined;
  }
}

/** @returns {boolean} true when this call created the lock (holding token); false when it exists already (any other error throws) */
function takeLock(lock, token) {
  try {
    writeFileSync(lock, token, { flag: CREATE_FLAGS, mode: FILE_MODE }); // a write cut short leaves a lock without a token: stale at 0.5 s
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** @returns {{stats: import('node:fs').Stats, text: string} | null} the lock read through one checked handle; null when it is gone */
function readLock(lock) {
  let fd;
  try {
    fd = openSync(lock, READ_FLAGS);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { stats, text: '' }; // never read a FIFO or device that was swapped in
    const buffer = Buffer.alloc(LOCK_TEXT_MAX_BYTES);
    return { stats, text: buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)) };
  } finally {
    closeSync(fd);
  }
}

/** @returns {boolean} true when the lock still holds token; false when it is gone, changed or cannot be read (then it is not ours) */
function holdsToken(lock, token) {
  try {
    return readLock(lock)?.text === token;
  } catch {
    return false; // a link or special file now at the lock's name: not our lock, so it is left alone
  }
}

/** @returns {boolean} false only when the process is known to be gone (ESRCH); EPERM means it runs under another user */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** Whether a held lock was left behind: see the header for the three cases. */
function isStale(held, nowMs) {
  const age = nowMs - held.stats.mtimeMs;
  if (age < -LOCK_CLOCK_SKEW_MS || age > HELD_LOCK_MAX_MS) return true;
  if (age <= STALE_LOCK_MS) return false;
  const owner = LOCK_OWNER.exec(held.text);
  return owner === null || !isAlive(Number(owner[1]));
}

/**
 * Removes a lock that was left behind (see isStale), one waiter at a time (breakStaleLock).
 * @returns {boolean} false when something other than this user's regular file holds the lock's or its breaker's name
 */
function clearStaleLock(dir, folder, lock) {
  const seen = lstatOrNull(lock);
  if (seen === null) return true; // released meanwhile: the next try takes it
  if (!isPrivateFile(seen)) return false;
  const held = readLock(lock);
  if (held === null) return true;
  if (!isPrivateFile(held.stats)) return false; // swapped after the lstat
  if (!isStale(held, Date.now())) return true;
  return !sameNode(lstatSync(dir), folder) || breakStaleLock(lock, held);
}

/**
 * Removes the lock judged stale (held) while holding `<lock>.break`, so no other waiter renames anything at the lock's name at the
 * same time. A waiter that cannot take the breaker file leaves the lock for its holder (a busy lock for it); a breaker file that is
 * stale itself (a waiter killed here) is removed.
 * @returns {boolean} false when something other than this user's regular file sits at the breaker's name
 */
function breakStaleLock(lock, held) {
  const breaker = `${lock}${BREAKER_SUFFIX}`;
  const token = `${process.pid} ${randomBytes(LOCK_TOKEN_BYTES).toString('hex')}`;
  if (!takeLock(breaker, token)) return clearStaleBreaker(breaker);
  try {
    const again = readLock(lock); // another waiter may have replaced the stale lock before this one got the breaker
    if (again !== null && sameNode(again.stats, held.stats) && again.text === held.text) removeStaleLock(lock, held);
  } finally {
    if (holdsToken(breaker, token)) rmSync(breaker, { force: true });
  }
  return true;
}

/** @returns {boolean} false when something other than this user's regular file sits at the breaker's name; a stale breaker is removed */
function clearStaleBreaker(breaker) {
  const seen = readLock(breaker);
  if (seen === null) return true;
  if (!isPrivateFile(seen.stats)) return false;
  if (!isStale(seen, Date.now())) return true;
  const again = readLock(breaker); // not removed if another waiter replaced it since
  if (again !== null && sameNode(again.stats, seen.stats) && again.text === seen.text) rmSync(breaker, { force: true });
  return true;
}

/**
 * Removes the lock judged stale (held) with no gap between the check and the delete: it is renamed to a unique name first (one
 * atomic step), then checked and deleted. Only the holder of the breaker file calls this. When the renamed file is not the one judged
 * stale (its holder released and a new caller took the lock in the instant since breakStaleLock read it), it is linked back at once.
 * @throws EEXIST when a third caller took the free name meanwhile (the moved lock is then gone); any other error of the rename (but
 *   ENOENT), the read or the link
 */
function removeStaleLock(lock, held) {
  const aside = `${lock}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.stale`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return; // released or cleared meanwhile: the next try takes it
    throw error;
  }
  try {
    const moved = readLock(aside);
    const judged = moved !== null && sameNode(moved.stats, held.stats) && moved.text === held.text;
    // a live lock moved by mistake: back under its name (same file, same mtime); EEXIST (a third caller took the name) throws, and
    // withSessionLock then gives up as for a busy lock
    if (!judged) linkSync(aside, lock);
  } finally {
    rmSync(aside, { force: true }); // the stale lock itself, or the extra name of the lock put back
  }
}

/** Runs work, then removes the lock while dir is still the checked folder and the lock still holds this caller's token. */
function runAndRelease(work, { dir, folder, lock, token }) {
  try {
    return work();
  } finally {
    if (holdsToken(lock, token) && sameNode(lstatSync(dir), folder)) rmSync(lock, { force: true });
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
