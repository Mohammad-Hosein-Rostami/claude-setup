// When disk-clean first saw each cs-test-* or clone folder of a session scratchpad (the session-scratch rule). Exports: FIRST_SEEN_STORE,
// recordKey, openFirstSeen.
// Why: a copy that keeps old times (`cp -a`, `tar x`) looks idle by its mtime the day it is made. The rule removes a folder only when its
// newest mtime is over 2 days old AND disk-clean first saw it over 2 days ago, so a folder made today is never taken for an old one.
// Store: one JSON file `~/.claude/state/disk-clean/first-seen.json` {"v":1,"seen":{<key>:<ms>}} through hooks/lib/session-store.mjs (no
// link followed, a size cap, written to a temp file and renamed, so a reader never sees half a file); the read-merge-write runs under
// hooks/lib/session-lock.mjs, so two runs at once (a dry run and --apply) keep both runs' entries. Key = the folder's real path (its
// name before a `.removing-*` rename) + device + inode: a new folder at an old name is a new folder.
// Stale case: an entry whose folder is gone, or whose path now holds another inode, is dropped on each save. Crash case: a run killed
// before its save loses only that run's new entries (seen again next run). Old-reader case: text that is not this shape (a torn or older
// file) reads as empty: every folder counts as first seen again, which only keeps folders longer. A store that cannot be used (an
// unsafe folder, a planted link) makes every folder count as first seen now, so the rule removes nothing.
import { isAbsolute, join } from 'node:path';
import { readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { withSessionLock } from '../../../hooks/lib/session-lock.mjs';
import { lstatOrNull } from './clean-scan.mjs';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024; // about 20,000 entries of a long path; a bigger file was not written here
export const FIRST_SEEN_STORE = { folder: (home) => join(home, '.claude', 'state', 'disk-clean'), id: 'first-seen' };

/** The record's key of a folder: its path (as named before any `.removing-*` rename), device and inode. */
export const recordKey = (path, info) => JSON.stringify([path, info.dev, info.ino]);

/** The entries of the store's text; an empty map for text of any other shape (torn, older, planted). */
function parseSeen(text) {
  try {
    const parsed = JSON.parse(text ?? '');
    const seen = parsed?.v === STORE_VERSION && typeof parsed.seen === 'object' && parsed.seen !== null ? parsed.seen : {};
    return new Map(Object.entries(seen).filter(([, ms]) => Number.isFinite(ms)));
  } catch {
    return new Map(); // not JSON: read as empty (see the header)
  }
}

/** True while the key's path still holds the same folder (device and inode). */
function stillThere(key) {
  try {
    const [path, dev, ino] = JSON.parse(key);
    const info = lstatOrNull(path);
    return info !== null && info.dev === dev && info.ino === ino;
  } catch {
    return false;
  }
}

/**
 * Opens the record for one run.
 * @param {string} home the home folder the store lives under
 * @param {() => number} clock the time a new entry gets (Date.now; never the run's --now, which may lie in the past)
 * @returns {{ firstSeenMs: (path: string, info: import('node:fs').Stats) => number | null, isNew: (path: string, info: import('node:fs').Stats) => boolean, save: () => void }}
 *   firstSeenMs records a folder met for the first time (at the clock) and returns its time; null when the store cannot be used
 */
export function openFirstSeen(home, clock = Date.now) {
  const { folder, id } = FIRST_SEEN_STORE;
  const text = typeof home === 'string' && isAbsolute(home) ? readSessionFile(folder(home), id, MAX_STORE_BYTES) : undefined;
  const known = text === undefined ? null : parseSeen(text);
  const added = new Map();
  return {
    firstSeenMs(path, info) {
      if (known === null) return null;
      const key = recordKey(path, info);
      if (!known.has(key) && !added.has(key)) added.set(key, clock());
      return known.get(key) ?? added.get(key);
    },
    isNew: (path, info) => added.has(recordKey(path, info)),
    save() {
      if (known === null) return;
      withSessionLock(folder(home), id, () => {
        const merged = parseSeen(readSessionFile(folder(home), id, MAX_STORE_BYTES));
        for (const [key, ms] of [...known, ...added]) merged.set(key, Math.min(ms, merged.get(key) ?? ms));
        const kept = Object.fromEntries([...merged].filter(([key]) => stillThere(key)));
        writeSessionFile(folder(home), id, JSON.stringify({ v: STORE_VERSION, seen: kept }), { sweep: false });
      });
    },
  };
}
