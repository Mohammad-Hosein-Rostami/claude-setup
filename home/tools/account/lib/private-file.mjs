// Purpose: read a file of the accounts folder only when it is what the tool wrote: a regular file of this user that
// nobody else can read, in a folder nobody else can enter.
// Exports: readPrivateFile, assertPrivateDir.
// Invariants: the file is opened without following a link and without waiting on a FIFO, and the checks (regular file,
// no group or other bits, size cap) run on that open descriptor, which is then the one that is read; a failed check
// throws, it never returns content. On Windows the mode bits mean nothing and are not checked (the profile folder's
// access controls protect the file; not verified).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { AccountError } from './names.mjs';

const OTHERS_MASK = 0o077;
const MODES_COUNT = process.platform !== 'win32';
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const unsafe = (path, why) => new AccountError('unsafe-file', `${path} ${why}; not read`);

/**
 * @param {string} dir the accounts folder.
 * @throws {AccountError} kind `unsafe-file` when it is a link, not a folder, or open to group or others.
 */
export function assertPrivateDir(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw unsafe(dir, 'is not a folder (a link?)');
  if (MODES_COUNT && (stat.mode & OTHERS_MASK) !== 0) throw unsafe(dir, 'is open to other users (expected mode 0700)');
}

function openChecked(path, maxBytes) {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw unsafe(path, 'is not a regular file');
    if (MODES_COUNT && (stat.mode & OTHERS_MASK) !== 0) throw unsafe(path, 'is readable by other users (expected mode 0600)');
    if (stat.size > maxBytes) throw unsafe(path, `is larger than ${maxBytes} bytes`);
    return { fd, size: stat.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * @param {string} path a file inside the accounts folder.
 * @param {number} maxBytes the cap its writer keeps.
 * @returns {string | null} the text, or null when there is no such file (or no accounts folder yet).
 * @throws {AccountError} kind `unsafe-file` for a link, a special file, a looser mode, a folder open to others or a file over the cap.
 */
export function readPrivateFile(path, maxBytes) {
  let opened;
  try {
    opened = openChecked(path, maxBytes);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw unsafe(path, 'is a link');
    throw error;
  }
  try {
    const buffer = Buffer.alloc(opened.size);
    const read = readSync(opened.fd, buffer, 0, opened.size, 0);
    return buffer.toString('utf8', 0, read);
  } finally {
    closeSync(opened.fd);
  }
}
