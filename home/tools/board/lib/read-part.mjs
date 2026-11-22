// A bounded read of a plain file, for the board's readers of Claude Code's internal agent files (transcripts, meta files, the agent-type
// pools) and of a repository's own files (git-state.mjs: packed-refs, the stash log, rebase steps). Export: readPart(file, max, fromEnd)
// -> { text, truncated } | null.
// Invariants: reads only a plain file (a link, a folder, a FIFO, a device or a missing path gives null) and never more than `max`
// bytes. The file is opened once without waiting or following a link and checked on that open file (hooks/lib/plain-file.mjs), so a
// FIFO swapped in after a look can never block the read.
import { readSync } from 'node:fs';
import { NOT_PLAIN_FILE, readPlainFileWith } from '../../../hooks/lib/plain-file.mjs';

/** The errors that mean "not a plain file here": missing, a link (ELOOP), a path through a file, a folder, a FIFO or a device. */
const NOT_PLAIN_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'EISDIR', NOT_PLAIN_FILE]);

/**
 * The first `max` bytes (head) or last `max` bytes (tail) of a plain file.
 * @param {string} file the path
 * @param {number} max the most bytes read
 * @param {boolean} fromEnd read the tail instead of the head
 * @returns {{ text: string, truncated: boolean } | null} null when it is not a plain file; `truncated`: the file was longer
 * @throws {Error} any other open or read error (EACCES, EIO ...)
 */
export function readPart(file, max, fromEnd) {
  try {
    return readPlainFileWith(file, (fd, size) => {
      const length = Math.min(size, max);
      const buffer = Buffer.alloc(length);
      const got = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
      return { text: buffer.toString('utf8', 0, got), truncated: size > max };
    });
  } catch (error) {
    if (NOT_PLAIN_CODES.has(error?.code)) return null;
    throw error;
  }
}
