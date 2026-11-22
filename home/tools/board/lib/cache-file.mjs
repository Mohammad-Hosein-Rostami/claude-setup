// The board refresher's own cache files (spec-tui "Data and speed"): per session the agent transcript cursors and the git cache,
// and one `pools` file of agent run times per type. Only the detached refresh reads and writes them; the status line never does,
// except `<session>-hues.json` (hue-store.mjs: the identity hues kept for the items on the board), which the status line and `/where` use.
// Exports: cacheDir(env), readCacheFile(name, env, maxBytes) -> object | null, writeCacheFile(name, value, env, maxBytes) -> boolean.
// File: ~/.claude/state/board-cache/<name>.json, through hooks/lib/session-store.mjs (no links, 0600, temp file and rename; files
// older than 7 days are swept on write, so a session's cache goes with its board).
// Invariants: never throws; a name must pass isSessionId; a value over maxBytes is not written (the old file stays).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';

/** @returns {string} the folder of the cache files (HOME from env, so tests and smoke runs use a scratch home) */
export const cacheDir = (env = process.env) => join(env.HOME || homedir(), '.claude', 'state', 'board-cache');

/**
 * @param {string} name a session id or `pools`
 * @param {Record<string, string | undefined>} env HOME
 * @param {number} maxBytes the largest file read
 * @returns {object | null} the parsed file, or null when missing, too big, unsafe or not JSON
 */
export function readCacheFile(name, env, maxBytes) {
  try {
    const text = readSessionFile(cacheDir(env), name, maxBytes);
    const value = typeof text === 'string' ? JSON.parse(text) : null;
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null; // half-written or planted: start again from nothing
  }
}

/**
 * @param {string} name a session id or `pools`
 * @param {object} value the content (JSON)
 * @param {Record<string, string | undefined>} env HOME
 * @param {number} maxBytes the largest file written
 * @returns {boolean} true when stored
 */
export function writeCacheFile(name, value, env, maxBytes) {
  try {
    const text = JSON.stringify(value);
    return text.length <= maxBytes && writeSessionFile(cacheDir(env), name, text);
  } catch {
    return false;
  }
}
