// Reads and replaces a STATUS.md for status.mjs without ever following a link, waiting on a FIFO or leaving half a file.
// Exports: MAX_STATUS_BYTES; readStatusFile(file) -> { text } | { refused }; replaceStatusFile(file, text).
// Invariants: a read goes through one handle opened with O_NOFOLLOW and O_NONBLOCK (POSIX) and checked with fstat, so a link,
// FIFO or device swapped in after the caller's lstat is refused, never followed or waited on; at most MAX_STATUS_BYTES are read.
// A write goes to a new temp file (random name, O_EXCL, O_NOFOLLOW, the file's own mode) renamed over the file, so a link at the
// file's name or at a temp name is replaced, never written through. Errors other than a refusal throw (the caller reports them).
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** 4 MiB: the largest live STATUS.md is about 60 KB; the whole file is read and written in one go. */
export const MAX_STATUS_BYTES = 4 << 20;
const TEMP_NAME_BYTES = 8;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // POSIX only, like O_NONBLOCK; Windows has neither (and no FIFO to block on)
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | NO_FOLLOW;

/**
 * Reads the file through one checked handle (see the header).
 * @param {string} file the STATUS.md path
 * @returns {{text: string} | {refused: string}} the text, or why it is not read: not a regular file, over MAX_STATUS_BYTES, or
 *   grown while it was read
 * @throws when the file cannot be opened (ELOOP for a link, ENOENT when missing)
 */
export function readStatusFile(file) {
  const fd = openSync(file, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { refused: 'is not a regular file (a link or special file)' };
    if (opened.size > MAX_STATUS_BYTES) return { refused: `is over ${MAX_STATUS_BYTES} bytes` };
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    let read;
    do {
      read = readSync(fd, buffer, length, buffer.length - length, length);
      length += read;
    } while (read > 0 && length < buffer.length);
    if (length > opened.size) return { refused: 'grew while it was read' };
    return { text: buffer.toString('utf8', 0, length) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes text to a new temp file next to `file` (never an existing file or link) and renames it over `file`.
 * @param {string} file the STATUS.md path
 * @param {string} text the new content
 * @throws when the temp file cannot be made or the rename fails (the temp file is removed either way)
 */
export function replaceStatusFile(file, text) {
  const temp = `${file}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;
  const fd = openSync(temp, NEW_FILE, lstatSync(file).mode & 0o777);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true }); // after the rename nothing is left at that name
  }
}
