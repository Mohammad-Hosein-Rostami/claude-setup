// Reads a file through one opened descriptor, so what is checked is what is read.
// Exports: readRegularFile(path, maxBytes) -> { bytes } | { skipped }.
// Invariants: the open never follows a symlink (O_NOFOLLOW) and never blocks on a FIFO (O_NONBLOCK); the type and size are
//   checked on the descriptor (fstat), not on the path, so a file swapped after the check cannot be read. Where the platform has
//   no such flag (Windows) the flag is 0 and a path check with lstat stands in for O_NOFOLLOW. Never returns or throws file text.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const LINK_ERROR_CODE = 'ELOOP';

/**
 * @param {string} path absolute path of the file
 * @param {number} maxBytes a bigger file is not read
 * @returns {{ bytes: Buffer } | { skipped: 'link' | 'not a regular file' | 'too large' }} why the file was not read, or its bytes
 * @throws an error with the system's `code` (ENOENT, EACCES, ...) when the file cannot be opened or read
 */
export function readRegularFile(path, maxBytes) {
  if (NO_FOLLOW === 0 && lstatSync(path).isSymbolicLink()) return { skipped: 'link' };
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    const info = fstatSync(fd);
    if (!info.isFile()) return { skipped: 'not a regular file' };
    if (info.size > maxBytes) return { skipped: 'too large' };
    return { bytes: readFileSync(fd) };
  } catch (err) {
    if (err.code === LINK_ERROR_CODE) return { skipped: 'link' };
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
