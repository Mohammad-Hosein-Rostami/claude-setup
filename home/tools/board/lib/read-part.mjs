// A bounded read of a plain file, for the board's readers of Claude Code's internal agent files (transcripts, meta files, the agent-type
// pools). Export: readPart(file, max, fromEnd) -> { text, truncated } | null.
// Invariants: reads only a plain file (a link, a folder or a missing path gives null) and never more than `max` bytes.
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';

/** The first `max` bytes (head) or last `max` bytes (tail) of a plain file; null when it is not a plain file. `truncated`: the file was longer. */
export function readPart(file, max, fromEnd) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) return null;
  const length = Math.min(info.size, max);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, 'r');
  try {
    readSync(handle, buffer, 0, length, fromEnd ? info.size - length : 0);
  } finally {
    closeSync(handle);
  }
  return { text: buffer.toString('utf8'), truncated: info.size > max };
}
