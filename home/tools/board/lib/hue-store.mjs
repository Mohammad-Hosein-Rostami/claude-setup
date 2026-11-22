// The identity hues a session's work items were given, kept between renders so that an item's colour never changes while it is
// live (identity.mjs; lead decision, fix round 1 of spec-tui-3). Used by the status line (home/statusline.mjs) and `/where`
// (board.mjs), which draw from the same file so both show one item in one colour.
// Exports: identityOf(session, board, { env, nowMs }) -> identity (identity.mjs boardIdentity, with the saved hues applied and any
// change saved).
// File: ~/.claude/state/board-cache/<session>-hues.json (cache-file.mjs: private folder, no links, temp file and rename, so a
// reader sees the old file or the new one, never half of one) = { v, items: [{ name, hue, seenMs, sinceMs }] }, at most MAX_HUE_BYTES.
// Invariants: never throws; a missing, unreadable, planted or half-written file starts fresh; written only when the assignment
// changed; a session id that is no plain file name (none, empty, with a slash, too long for the suffix) keeps no file.
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { readCacheFile, writeCacheFile } from './cache-file.mjs';
import { boardIdentity } from './identity.mjs';

const MAX_HUE_BYTES = 16 * 1024;
const HUES_SUFFIX = '-hues';

/**
 * @param {string | undefined} session the session id
 * @param {object | null} board the session's board
 * @param {{ env?: Record<string, string | undefined>, nowMs?: number }} [deps] HOME (tests use a temp home) and the clock
 * @returns {ReturnType<typeof boardIdentity> | null} the board's identity: saved hues kept, new items given free hues, the file
 *   updated; null when it could not be worked out (the renderer then works it out itself, from the board alone)
 */
export function identityOf(session, board, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const name = `${session}${HUES_SUFFIX}`;
    const saved = isSessionId(session) ? readCacheFile(name, env, MAX_HUE_BYTES) : null;
    const identity = boardIdentity(board, saved, nowMs);
    if (identity.store !== null && isSessionId(session)) writeCacheFile(name, identity.store, env, MAX_HUE_BYTES);
    return identity;
  } catch {
    return null;
  }
}
