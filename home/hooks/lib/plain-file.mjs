// Opens for a file whose path someone else may have planted: the guard's host list, the decision log, the edit log and a session transcript.
// Exports: readPlainFile(path, maxBytes) -> string (throws); readPlainFileTail(path, tailBytes) -> string (throws);
//   readPlainFileWith(path, read) -> what read returns (throws), for a caller that picks its own range from the size;
//   appendPlainFile(path, text, {mode, maxBytes}) -> boolean; NOT_PLAIN_FILE.
// A hook must answer before its timeout, so no open here waits and none follows a link: the file is opened with O_NONBLOCK and O_NOFOLLOW,
// and only what fstat calls a regular file is read or written. A link fails to open (ELOOP); a FIFO nobody reads fails to open for
// writing (ENXIO) and is refused after fstat for reading; a device or a folder is refused the same way. A size cap bounds every read.
// Invariants: never blocks, never follows a link at the last path part, never reads more than its cap (maxBytes or tailBytes), closes what it opens.
// O_NOFOLLOW and O_NONBLOCK are POSIX only (Windows has neither, and no FIFO to block on).
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';

const SAFE_FLAGS = (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | SAFE_FLAGS;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | SAFE_FLAGS;
const OWNER_ONLY_MODE = 0o600;

/** `code` of the error for a path that opens but is not a regular file within the cap. */
export const NOT_PLAIN_FILE = 'ENOTPLAIN';

const notPlain = (path, why) => Object.assign(new Error(`${path}: ${why}`), { code: NOT_PLAIN_FILE });

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
  const fd = openSync(path, READ_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw notPlain(path, 'not a regular file');
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
 * The last `tailBytes` of a regular file (all of it when smaller), read without waiting and without following a link. For a log that
 * grows past any cap (a session transcript), where only the newest lines matter; the first line may start mid-line or mid-character.
 * @param {string} path the file
 * @param {number} tailBytes the most bytes read, from the end
 * @returns {string} the tail as UTF-8
 * @throws {Error} the open error (`ENOENT` when missing, `ELOOP` for a link), or one with code NOT_PLAIN_FILE for a FIFO, device or folder
 */
export function readPlainFileTail(path, tailBytes) {
  return readPlainFileWith(path, (fd, size) => {
    const length = Math.min(size, tailBytes);
    return readText(fd, length, size - length);
  });
}

/**
 * Appends text to a regular file (created when missing) without waiting and without following a link, and sets its mode.
 * @param {string} path the file
 * @param {string} text what to append
 * @param {{mode?: number, maxBytes?: number}} [limits] file mode (owner only by default; the mode given to open applies only when the
 *   file is created, so it is set again), and the size the file may reach (no cap by default)
 * @returns {boolean} false when nothing was written: the path is a FIFO, device or folder, or the text would pass maxBytes
 * @throws {Error} the open error (`ELOOP` for a link, `ENXIO` for a FIFO nobody reads, `EACCES` ...)
 */
export function appendPlainFile(path, text, { mode = OWNER_ONLY_MODE, maxBytes = Infinity } = {}) {
  const fd = openSync(path, APPEND_FLAGS, mode);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size + Buffer.byteLength(text) > maxBytes) return false;
    writeFileSync(fd, text);
    fchmodSync(fd, mode);
    return true;
  } finally {
    closeSync(fd);
  }
}
