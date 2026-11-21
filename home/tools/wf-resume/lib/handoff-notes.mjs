// Reads the "Don't redo" list out of a HANDOFF.md (the `handoff` skill's item 5; spec-p3 `r9-resume` O3), for the session-start notice and
// the digest (`r9-digest` reuses it).
// Exports: readHandoffDontRedo(path) -> string[], dontRedoItems(text) -> string[], MAX_ITEMS.
// Where the list is: the lines under a heading whose text holds "Don't redo" (any level, any case, straight or curly quote), or after a
// line that starts with that label (`**Don't redo**:`, `5. Don't redo:`), up to the next heading; each `-`, `*` or numbered item is one entry.
// Invariants: reads at most MAX_BYTES of a regular file; a missing or unreadable file is []; never throws; at most MAX_ITEMS of at most
// MAX_ITEM_CHARS each.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 300;
const MAX_BYTES = 256 * 1024;
const LABEL = /don['\u2019]?t\s+redo/i;
const HEADING = /^#{1,6}\s/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** The "Don't redo" items of a HANDOFF.md text. */
export function dontRedoItems(text) {
  const items = [];
  let inside = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (HEADING.test(line)) {
      inside = LABEL.test(line);
      continue;
    }
    if (!inside && LABEL.test(line) && /^\s*(?:[-*+]|\d+[.)])?\s*\**\s*don/i.test(line)) {
      inside = true;
      const rest = line.split(/:\s*/).slice(1).join(': ').trim();
      if (rest !== '') items.push(rest);
      continue;
    }
    const item = inside ? ITEM.exec(line) : null;
    if (item !== null && item[1].trim() !== '') items.push(item[1].trim());
  }
  return items.slice(0, MAX_ITEMS).map((item) => item.slice(0, MAX_ITEM_CHARS));
}

/** The items of the HANDOFF.md at `path`; [] when it is missing, not a regular file or unreadable. */
export function readHandoffDontRedo(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    if (!fstatSync(fd).isFile()) return [];
    const buffer = Buffer.alloc(MAX_BYTES);
    return dontRedoItems(buffer.toString('utf8', 0, readSync(fd, buffer, 0, MAX_BYTES, 0)));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
