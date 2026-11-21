// Purpose: keep the recall index under a size bound. When its live data passes the bound, the chunks of the oldest
// transcripts (oldest file mtime first) are deleted until it is under the bound again.
// Exports: boundIndexSize, MAX_INDEX_BYTES.
// Invariants: only transcript chunks (`.jsonl` sources) go; checkpoint notes (`note:<session>`) and project docs stay; a
// pruned transcript keeps its `files` row, so it is not indexed again unless it grows (then only its new lines are
// added); a file still being indexed (mtime 0) is never pruned; the index file itself does not shrink (no VACUUM,
// which would need as much free disk again), but SQLite reuses the freed pages, so the file stops growing near the
// bound. RECALL_MAX_INDEX_MB (a whole number of MiB) moves the bound.
const MIB = 1024 * 1024;
// 2 GiB: twice the 1.0 GB measured on 2026-11-19, when the index held 30 days of transcripts (7.0 GB on disk).
export const MAX_INDEX_BYTES = 2048 * MIB;

/** Bytes of the pages in use: all pages minus the free list. */
function liveBytes(db) {
  const value = (pragma) => Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0];
  return (value('page_count') - value('freelist_count')) * value('page_size');
}

/** The bound in bytes: RECALL_MAX_INDEX_MB when it is a positive whole number, else MAX_INDEX_BYTES. */
function boundBytes(env) {
  const mib = Number(env.RECALL_MAX_INDEX_MB);
  return Number.isInteger(mib) && mib > 0 ? mib * MIB : MAX_INDEX_BYTES;
}

/**
 * Delete the chunks of the oldest transcripts while the index holds more live data than the bound.
 * @param {object} store an open recall store (store.mjs).
 * @param {object} [env] process env (RECALL_MAX_INDEX_MB).
 * @returns {number} how many transcripts lost their chunks (0 when the index is under the bound).
 * @throws when the index cannot be read or written.
 */
export function boundIndexSize(store, env = process.env) {
  const limit = boundBytes(env);
  if (liveBytes(store.db) <= limit) return 0;
  const oldest = store.db.prepare("SELECT path FROM files WHERE path LIKE '%.jsonl' AND mtime > 0 ORDER BY mtime ASC").all();
  let pruned = 0;
  for (const { path } of oldest) {
    if (liveBytes(store.db) <= limit) break;
    store.transaction(() => store.deleteSource(path));
    pruned += 1;
  }
  return pruned;
}
