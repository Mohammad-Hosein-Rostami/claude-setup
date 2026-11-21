// The status line's estimate segment: reads a small cache of the estimate's text and, when the cache is missing or out of date,
// starts a detached refresh. Used by home/statusline.mjs on every render; written by ../statusline-cache.mjs.
// Exports: estimateSegment({ projectDir, sessionId, projectSinceMs }, deps) -> { kind, text, highMs, progress, numbers } | null; refreshNow(statusPath, sessionId, deps) ->
// boolean (status.mjs after a row edit); readEntry, writeEntry, cacheDir (the cache file store);
// SEGMENT_KINDS, OVERDUE_TEXT, MAX_CACHE_BYTES, STALE_SHOW_MS, REFRESH_INTERVAL_MS, RECOMPUTE_AFTER_MS.
// Invariants:
// - The STATUS.md looked at is the one the session last edited with status.mjs (its link in the estimate store), else <projectDir>/STATUS.md.
// - Fast: a render reads one small link file, does one stat of STATUS.md and one small cache read. It never imports the forecast,
//   the table parser or the transcript reader, so it can never read a transcript. The text comes only from the refresh script.
// - Cache file: ~/.claude/state/estimate-segment/<sha256 of the STATUS.md path, 32 hex>.json, one JSON object
//   {path, kind, text, highMs, progress, numbers, mtimeMs, size, computedAt, refreshStartedAt}; numbers (job-rows.mjs jobNumbers, or
//   null) is checked like progress and passed on as `numbers` (the render makes its text from them; an entry with numbers and no
//   text is shown); progress is the job's progress (progress.mjs
//   progressOf, a small object) or null, shown by the status line's second line under the same freshness rules as the text; kind is one of SEGMENT_KINDS and text is what to show
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
export const MAX_CACHE_BYTES = 16384; // an entry is ~200 bytes plus ~70 per open row in numbers (at most MAX_CACHE_ROWS, 64): ~5 KB
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
const isCount = (value) => Number.isInteger(value) && value >= 0;
const PROGRESS_TAGS = [null, 'moved', '+rows', 'overdue'];
const MAX_PERCENT = 100;

/** True for the object progressOf returns (a stored one is checked, never trusted: it is printed on the status line). */
const isProgress = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && isCount(value.pct) && value.pct <= MAX_PERCENT && typeof value.approx === 'boolean' && isCount(value.rowsDone) && isCount(value.rowsTotal)
  && (value.leftMin === null || isNumber(value.leftMin)) && PROGRESS_TAGS.includes(value.tag);

const isRowNumbers = (row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && isNumber(row.expectMin)
  && (row.startedMs === null || isNumber(row.startedMs));
const orNull = (value) => value === null || isNumber(value);
/** True for the numbers job-rows.mjs jobNumbers returns (checked, never trusted, like progress). */
const isNumbers = (value) => value !== null && typeof value === 'object' && orNull(value.finishMs) && orNull(value.p85Ms ?? null)
  && orNull(value.leftMin) && isNumber(value.workedMin) && isCount(value.rowsDone) && isCount(value.rowsTotal)
  && Array.isArray(value.rows) && value.rows.every(isRowNumbers);

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
    return valid ? { ...entry, progress: isProgress(entry.progress) ? entry.progress : null, numbers: isNumbers(entry.numbers) ? entry.numbers : null } : null;
  } catch {
    return null; // a half-written or foreign file: treated as no cache, the next refresh replaces it
  }
}

/** @returns {boolean} true when the entry was stored (see writeSessionFile) */
export const writeEntry = (dir, statusPath, entry) => writeSessionFile(dir, cacheId(statusPath), JSON.stringify(entry));

const matchesFile = (entry, file) => entry.mtimeMs === file.mtimeMs && entry.size === file.size;

/**
 * The text and progress to show: the cached ones while the entry matches the file (a hand-over only then), else for STALE_SHOW_MS after
 * it was computed; once a finish's clock has passed, OVERDUE_TEXT and the overdue tag.
 */
function shownEntry(entry, file, now) {
  if (entry === null || (entry.text === null && entry.numbers === null)) return null;
  const current = matchesFile(entry, file) || (entry.kind !== 'handed-over' && now - entry.computedAt < STALE_SHOW_MS);
  if (!current) return null;
  const shown = { kind: entry.kind, highMs: entry.highMs, numbers: entry.numbers };
  if (entry.highMs === null || now <= entry.highMs) return { ...shown, text: entry.text, progress: entry.progress };
  return { ...shown, text: OVERDUE_TEXT, progress: entry.progress === null ? null : { ...entry.progress, tag: 'overdue' } };
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
  const base = entry ?? { path: statusPath, kind: null, text: null, highMs: null, progress: null, mtimeMs: 0, size: 0, computedAt: 0 };
  return writeEntry(dir, statusPath, { ...base, refreshStartedAt: now });
}

/** A refresh claimed this long ago that has not written its result yet is taken as still running (one refresh at a time). */
const IN_FLIGHT_MS = 60 * 1000;

/**
 * Starts the refresh at once after a row edit (audit case 6: the shown text lagged `status.mjs done` by up to 2.5 min), with the
 * same claim as a render, so a refresh already running is not doubled. Never throws.
 * @param {string} statusPath the STATUS.md's real path
 * @param {string | undefined} sessionId the session whose transcripts count
 * @param {{ cacheDir?: string, now?: number, spawnRefresh?: (statusPath: string, sessionId?: string) => void }} [deps] tests replace them
 * @returns {boolean} true when a refresh was started
 */
export function refreshNow(statusPath, sessionId, deps = {}) {
  try {
    const { cacheDir: dir = cacheDir(), now = Date.now(), spawnRefresh: start = spawnRefresh } = deps;
    const entry = readEntry(dir, statusPath);
    const running = entry !== null && entry.refreshStartedAt > entry.computedAt && now - entry.refreshStartedAt < IN_FLIGHT_MS;
    if (running || !claimRefresh(dir, statusPath, entry, now)) return false;
    start(statusPath, sessionId);
    return true;
  } catch {
    return false; // the edit stands; the next render starts the refresh
  }
}

/**
 * The session's linked STATUS.md, else the project's when it changed at or after `projectSinceMs` (audit case 2: a project's old
 * STATUS.md, another session's or a finished job, is not this session's job); null when neither.
 */
function statusPathOf({ projectDir, sessionId, projectSinceMs }, store) {
  const linked = isSessionId(sessionId) ? linkedStatusPath(store, sessionId) : null;
  if (linked !== null) return { path: linked, linked: true };
  if (typeof projectDir !== 'string' || projectDir === '') return null;
  return { path: join(projectDir, 'STATUS.md'), linked: false, sinceMs: typeof projectSinceMs === 'number' ? projectSinceMs : -Infinity };
}

/**
 * The status line's estimate segment for a session.
 * @param {{ projectDir?: string, sessionId?: string, projectSinceMs?: number }} where the project folder and the session id from the
 *   status line's JSON; projectSinceMs: the project's STATUS.md counts only when changed at or after it (the session's start; the
 *   status line passes it, unset means any time)
 * @param {{cacheDir?: string, stateDir?: string, now?: number, spawnRefresh?: (statusPath: string, sessionId?: string) => void}} [deps]
 *   the cache folder, the estimate store (for the session's link), the clock (epoch ms) and the refresh starter; tests replace them
 * @returns {{ kind: string | null, text: string | null, highMs: number | null, progress: object | null, numbers: object | null } | null} text e.g. "done by 21:40", "handed over 17:54" or "done ? few rows"; progress
 *   as progressOf returns it, or null; null for no segment (no STATUS.md, no cache yet, any error)
 */
export function estimateSegment({ projectDir, sessionId, projectSinceMs } = {}, deps = {}) {
  try {
    const { cacheDir: dir = cacheDir(), stateDir: store = stateDir(), now = Date.now(), spawnRefresh: start = spawnRefresh } = deps;
    const where = statusPathOf({ projectDir, sessionId, projectSinceMs }, store);
    if (where === null) return null;
    const statusPath = where.path;
    const file = statSync(statusPath, { throwIfNoEntry: false });
    if (!file?.isFile() || (!where.linked && file.mtimeMs < where.sinceMs)) return null;
    const entry = readEntry(dir, statusPath);
    if (refreshDue(entry, file, now) && claimRefresh(dir, statusPath, entry, now)) start(statusPath, sessionId);
    return shownEntry(entry, file, now);
  } catch {
    return null; // the status line must always render; no segment is the safe answer
  }
}
