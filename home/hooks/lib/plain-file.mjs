// Opens for a file whose path someone else may have planted: a session transcript, a hook's state or log file, a tool's record.
// Exports: openPlainFile(path, flags, mode) -> {fd, stat} (throws), the one open the others build on, for a caller with its own
//   flags (a lock made with O_EXCL, a log read before it is appended);
//   readPlainFile(path, maxBytes) -> string (throws);
//   readPlainFileWith(path, read) -> what read returns (throws), for a caller that picks its own range from the size;
//   appendPlainFile(path, text, {mode, maxBytes}) -> boolean; NOT_PLAIN_FILE.
// A hook must answer before its timeout, so no open here waits and none follows a link: the file is opened with O_NONBLOCK and O_NOFOLLOW,
// and only what fstat calls a regular file is read or written. A link fails to open (ELOOP); a FIFO nobody reads fails to open for
// writing (ENXIO) and is refused after fstat for reading; a device or a folder is refused the same way. A size cap bounds every read.
// An append also refuses a file with a second hard link (fstat nlink > 1, as tools/ask/lib/store.mjs does): O_NOFOLLOW stops only a
// symlink, and a hard link planted at the path (`ln ~/owner-file <log>`) would send the line into one of the owner's own files.
// Invariants: never blocks, never follows a link at the last path part, never appends to a file with more than one hard link, never
// reads more than its cap, closes what it opens.
// O_NOFOLLOW and O_NONBLOCK are POSIX only (Windows has neither, and no FIFO to block on).
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';

const SAFE_FLAGS = (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | SAFE_FLAGS;
const OWNER_ONLY_MODE = 0o600;

/** `code` of the error for a path that opens but is not a regular file within the cap. */
export const NOT_PLAIN_FILE = 'ENOTPLAIN';

const notPlain = (path, why) => Object.assign(new Error(`${path}: ${why}`), { code: NOT_PLAIN_FILE });

/**
 * Opens a path without waiting and without following a link at its last part, and keeps it open only when fstat says regular file.
 * Why: the check runs on the opened file, never on the path, so a FIFO or link swapped in between a check and the open is still
 * refused. Without O_NOFOLLOW (Windows) a link is followed, and this fstat check is all that is left.
 * @param {string} path the file
 * @param {number} flags the access flags (`constants.O_RDONLY`, or a write mode with O_APPEND, O_CREAT, O_EXCL ...); O_NONBLOCK and
 *   O_NOFOLLOW are added
 * @param {number} [mode] the mode of a file that O_CREAT makes (owner only by default)
 * @returns {{fd: number, stat: import('node:fs').Stats}} the open fd, which the caller closes, and its fstat
 * @throws {Error} the open error (`ENOENT` when missing, `ELOOP` for a link, `EEXIST` with O_EXCL, `ENXIO` for a FIFO nobody reads
 *   ...), or one with code NOT_PLAIN_FILE for a FIFO, device or folder (the fd is closed then)
 */
export function openPlainFile(path, flags, mode = OWNER_ONLY_MODE) {
  const fd = openSync(path, flags | SAFE_FLAGS, mode);
  let stat;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile()) throw notPlain(path, 'not a regular file');
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { fd, stat };
}

/**
 * Opens a path for reading without waiting or following a link, and gives its fd and size to `read` when fstat says regular file.
 * For a caller that picks its own range from the size (a head, a tail cut at a line start, the bytes after an offset).
 * @template T
 * @param {string} path the file
 * @param {(fd: number, size: number) => T} read reads from the open fd; it must not close it
 * @returns {T} what `read` returns
 * @throws {Error} the open error (`ENOENT` when missing, `ELOOP` for a link), or one with code NOT_PLAIN_FILE for a FIFO, device or folder
 */
export function readPlainFileWith(path, read) {
  const { fd, stat } = openPlainFile(path, constants.O_RDONLY);
  try {
    return read(fd, stat.size);
  } finally {
    closeSync(fd);
  }
}

function readText(fd, length, position) {
  const buffer = Buffer.alloc(length);
  return buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, position));
}

/**
 * The text of a regular file, read without waiting and without following a link.
 * @param {string} path the file
 * @param {number} maxBytes the most the file may hold
 * @returns {string} its content as UTF-8
 * @throws {Error} the open error (`ENOENT` when missing, `ELOOP` for a link), or one with code NOT_PLAIN_FILE for a FIFO, device,
 *   folder or a file over maxBytes
 */
export function readPlainFile(path, maxBytes) {
  return readPlainFileWith(path, (fd, size) => {
    if (size > maxBytes) throw notPlain(path, `larger than ${maxBytes} bytes`);
    return readText(fd, size, 0);
  });
}

/**
 * Appends text to a regular file (created when missing) without waiting and without following a link, and sets its mode.
 * @param {string} path the file
 * @param {string} text what to append
 * @param {{mode?: number, maxBytes?: number}} [limits] file mode (owner only by default; the mode given to open applies only when the
 *   file is created, so it is set again), and the size the file may reach (no cap by default)
 * @returns {boolean} false when nothing was written (neither text nor mode): the path is a FIFO, device or folder, a file with more
 *   than one hard link, or the text would pass maxBytes
 * @throws {Error} the open error (`ELOOP` for a link, `ENXIO` for a FIFO nobody reads, `EACCES` ...)
 */
export function appendPlainFile(path, text, { mode = OWNER_ONLY_MODE, maxBytes = Infinity } = {}) {
  const fd = openSync(path, APPEND_FLAGS, mode);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size + Buffer.byteLength(text) > maxBytes) return false;
    writeFileSync(fd, text);
    fchmodSync(fd, mode);
    return true;
  } finally {
    closeSync(fd);
  }
}
