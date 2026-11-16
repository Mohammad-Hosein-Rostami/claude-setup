// The status line's estimate segment: reads a small cache of the estimate's text and, when the cache is missing or out of date,
// starts a detached refresh. Used by home/statusline.mjs on every render; written by ../statusline-cache.mjs.
// Exports: estimateSegment({ projectDir, sessionId }, deps) -> string | null; readEntry, writeEntry, cacheDir (the cache file store);
// SEGMENT_KINDS, OVERDUE_TEXT, MAX_CACHE_BYTES, STALE_SHOW_MS, REFRESH_INTERVAL_MS, RECOMPUTE_AFTER_MS.
// Invariants:
// - The STATUS.md looked at is the one the session last touched (its link in the estimate store), else <projectDir>/STATUS.md.
// - Fast: a render reads one small link file, does one stat of STATUS.md and one small cache read. It never imports the forecast,
//   the table parser or the transcript reader, so it can never read a transcript. The text comes only from the refresh script.
// - Cache file: ~/.claude/state/estimate-segment/<sha256 of the STATUS.md path, 32 hex>.json, one JSON object
//   {path, kind, text, highMs, mtimeMs, size, computedAt, refreshStartedAt}; kind is one of SEGMENT_KINDS and text is what to show
//   (a finish, a hand-over, the work left of a long job, or `done ? <cause>` after a refusal or an error); highMs (epoch ms) is the
//   shown clock of a finish, after which OVERDUE_TEXT is shown; null for the other kinds. An entry of another kind (written by the
//   old tool) is no entry: the next refresh replaces it. A handed-over text is shown only while STATUS.md is unchanged; any other
//   text also for STALE_SHOW_MS after a change. Opened and replaced through hooks/lib/session-store.mjs (no links, 0600, temp file + rename).
// - A render claims a refresh by writing refreshStartedAt before it spawns; if the claim cannot be written (a link planted at the cache
//   path, a read-only home) it spawns nothing, so a broken cache can never cause a refresh storm.
// - Never throws and never prints: any failure means "no segment".
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { linkedStatusPath, stateDir } from './table-store.mjs';

// What a cache entry holds (the refresh script, via lib/segment-text.mjs, writes them; the render only reads them). Here and not in
// segment-text.mjs, which loads the report: the render must stay light.
export const SEGMENT_KINDS = ['finish', 'handed-over', 'work-left', 'refused', 'error'];
export const OVERDUE_TEXT = 'done ? overdue'; // shown in place of a finish whose clock has passed
export const MAX_CACHE_BYTES = 4096; // an entry is ~200 bytes; a bigger file was not written by the refresh script
export const STALE_SHOW_MS = 15 * 60 * 1000; // text of a changed STATUS.md is still shown this long while its refresh runs
export const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // at most one refresh start per STATUS.md in this time
// The committed time slides with every pause even when STATUS.md does not change, and the hand-over or a move can come with the
// clock alone: recompute after this age. The shown clock moves in 5-minute steps.
export const RECOMPUTE_AFTER_MS = 5 * 60 * 1000;
const CACHE_ID_HEX_CHARS = 32;
const REFRESH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'statusline-cache.mjs');

/** @returns {string} the folder holding the cache files (under ~/.claude/state, like the other stores) */
export const cacheDir = () => join(homedir(), '.claude', 'state', 'estimate-segment');

const cacheId = (statusPath) => createHash('sha256').update(statusPath).digest('hex').slice(0, CACHE_ID_HEX_CHARS);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @param {string} dir the cache folder
 * @param {string} statusPath absolute path of the STATUS.md the entry is about
 * @returns {object | null} the entry, or null when there is none, it is unusable (link, too big, bad JSON, wrong fields or kind) or
 *   it is for another path
 */
export function readEntry(dir, statusPath) {
  const text = readSessionFile(dir, cacheId(statusPath), MAX_CACHE_BYTES);
  if (typeof text !== 'string') return null;
  try {
    const entry = JSON.parse(text);
    const valid = entry?.path === statusPath && (entry.text === null || typeof entry.text === 'string') && (entry.highMs === null || isNumber(entry.highMs))
      && (entry.kind === null || SEGMENT_KINDS.includes(entry.kind))
      && ['mtimeMs', 'size', 'computedAt', 'refreshStartedAt'].every((field) => isNumber(entry[field]));
    return valid ? entry : null;
  } catch {
    return null; // a half-written or foreign file: treated as no cache, the next refresh replaces it
  }
}

/** @returns {boolean} true when the entry was stored (see writeSessionFile) */
export const writeEntry = (dir, statusPath, entry) => writeSessionFile(dir, cacheId(statusPath), JSON.stringify(entry));

const matchesFile = (entry, file) => entry.mtimeMs === file.mtimeMs && entry.size === file.size;

/**
 * The text to show: the cached text while it matches the file (a hand-over only then), else for STALE_SHOW_MS after it was
 * computed; once a finish's clock has passed, OVERDUE_TEXT.
 */
function segmentText(entry, file, now) {
  if (entry === null || entry.text === null) return null;
  const current = matchesFile(entry, file) || (entry.kind !== 'handed-over' && now - entry.computedAt < STALE_SHOW_MS);
  if (!current) return null;
  if (entry.highMs === null || now <= entry.highMs) return entry.text;
  return OVERDUE_TEXT;
}

/**
 * A refresh is due when the cache does not describe the file as it is now or is RECOMPUTE_AFTER_MS old, and none was started in
 * the last REFRESH_INTERVAL_MS.
 */
const refreshDue = (entry, file, now) => entry === null
  || ((!matchesFile(entry, file) || now - entry.computedAt >= RECOMPUTE_AFTER_MS) && now - entry.refreshStartedAt >= REFRESH_INTERVAL_MS);

/** Starts the refresh script for a STATUS.md (and the session whose transcripts count), detached, and does not wait for it. */
function spawnRefresh(statusPath, sessionId) {
  const args = [REFRESH_SCRIPT, statusPath, ...(isSessionId(sessionId) ? [sessionId] : [])];
  const child = spawn(process.execPath, args, { cwd: dirname(statusPath), detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    // node not spawnable: the status line must not crash on a failed background refresh; the next interval tries again
  });
  child.unref();
}

/** Writes the claim "a refresh started at now", keeping what the old entry knew; false when it could not be stored. */
function claimRefresh(dir, statusPath, entry, now) {
  const base = entry ?? { path: statusPath, kind: null, text: null, highMs: null, mtimeMs: 0, size: 0, computedAt: 0 };
  return writeEntry(dir, statusPath, { ...base, refreshStartedAt: now });
}

/** The session's linked STATUS.md, else the project's; null when neither is known. */
function statusPathOf(projectDir, sessionId, store) {
  const linked = isSessionId(sessionId) ? linkedStatusPath(store, sessionId) : null;
  if (linked !== null) return linked;
  return typeof projectDir === 'string' && projectDir !== '' ? join(projectDir, 'STATUS.md') : null;
}

/**
 * The status line's estimate segment for a session.
 * @param {{ projectDir?: string, sessionId?: string }} where the project folder and the session id from the status line's JSON
 * @param {{cacheDir?: string, stateDir?: string, now?: number, spawnRefresh?: (statusPath: string, sessionId?: string) => void}} [deps]
 *   the cache folder, the estimate store (for the session's link), the clock (epoch ms) and the refresh starter; tests replace them
 * @returns {string | null} e.g. "done by 21:40", "handed over 17:54" or "done ? few rows", or null for no segment (no STATUS.md,
 *   no cache yet, any error)
 */
export function estimateSegment({ projectDir, sessionId } = {}, deps = {}) {
  try {
    const { cacheDir: dir = cacheDir(), stateDir: store = stateDir(), now = Date.now(), spawnRefresh: start = spawnRefresh } = deps;
    const statusPath = statusPathOf(projectDir, sessionId, store);
    if (statusPath === null) return null;
    const file = statSync(statusPath, { throwIfNoEntry: false });
    if (!file?.isFile()) return null;
    const entry = readEntry(dir, statusPath);
    if (refreshDue(entry, file, now) && claimRefresh(dir, statusPath, entry, now)) start(statusPath, sessionId);
    return segmentText(entry, file, now);
  } catch {
    return null; // the status line must always render; no segment is the safe answer
  }
}
