// The minutes a session was active, read from its transcripts, kept in a per-session index so each run reads only appended bytes.
// Exports: sessionTranscripts(projectsDir, sessionId) -> paths, activeRuns(sessionIds, { projectsDir, stateDir }) -> runs.
// An active minute is the UTC minute of any occurrence of the bytes `"timestamp":"YYYY-MM-DDTHH:MM` in the session's transcripts
// (<projects>/<folder>/<id>.jsonl and every .jsonl at any depth under <projects>/<folder>/<id>/). Text quoted inside a tool result
// is escaped (`\"timestamp\"`) and does not match. Lines are never decoded: a transcript line can be several MB.
// Invariants: the index <stateDir>/activity/<id>.json is { v: 2, files: { path: bytesRead }, runs: [[startMin, endMin]] }, written
// through hooks/lib/session-store.mjs with sweep off; minutes are only ever added, so the index outlives the transcripts (Claude Code
// deletes old ones). The stored offset stays OVERLAP_BYTES short of what was read, so a match cut by the end of a read is seen whole
// next time; a file shorter than its offset is read from 0. No lock is taken: each writer stores offsets and minutes from one
// consistent read, so a lost write is only read again. Without a stateDir nothing is read from or written to the index.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionId, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';

const INDEX_VERSION = 2;
const ACTIVITY_FOLDER = 'activity';
const MAX_ACTIVITY_BYTES = 1 << 20; // 1 MiB: a session with 1200 subagent files (the longest measured) needs about 200 KB
const READ_CHUNK_BYTES = 1 << 20; // 1 MiB per read: the scan holds one chunk, never a whole line
const PATTERN = Buffer.from('"timestamp":"');
const STAMP_BYTES = 16; // YYYY-MM-DDTHH:MM
const MATCH_BYTES = PATTERN.length + STAMP_BYTES;
const OVERLAP_BYTES = 40; // more than MATCH_BYTES (29): a match cut by a chunk or read end is inside the next read
const STAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MS_PER_MIN = 60_000;
const TRANSCRIPT_SUFFIX = '.jsonl';
const MISSING_CODES = ['ENOENT', 'ENOTDIR'];

/** lstat, or null when nothing is there; other errors (permissions) throw. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (MISSING_CODES.includes(error.code)) return null;
    throw error;
  }
}

/** Every regular .jsonl file at any depth under folder (links are not followed). */
function nestedTranscripts(folder) {
  return readdirSync(folder, { recursive: true })
    .filter((name) => name.endsWith(TRANSCRIPT_SUFFIX))
    .map((name) => join(folder, name))
    .filter((path) => lstatOrNull(path)?.isFile() === true);
}

/**
 * The transcript files of a session, in every project folder: the main file and every nested .jsonl (subagents, workflows).
 * @param {string} projectsDir Claude Code's projects folder (~/.claude/projects)
 * @param {string} sessionId the session id; an id that is not safe as a file name finds nothing
 * @returns {string[]} absolute paths, main file first per folder, nested ones sorted
 */
export function sessionTranscripts(projectsDir, sessionId) {
  if (!isSessionId(sessionId) || lstatOrNull(projectsDir)?.isDirectory() !== true) return [];
  const found = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const folder = join(projectsDir, entry.name);
    const main = join(folder, `${sessionId}${TRANSCRIPT_SUFFIX}`);
    if (lstatOrNull(main)?.isFile() === true) found.push(main);
    const nested = join(folder, sessionId);
    if (lstatOrNull(nested)?.isDirectory() === true) found.push(...nestedTranscripts(nested).sort());
  }
  return found;
}

/** Adds the minute after each pattern match in buffer[0, length) to minutes; a match not complete inside the buffer is left out. */
function collectMinutes(buffer, length, minutes) {
  for (let at = buffer.indexOf(PATTERN); at !== -1 && at + MATCH_BYTES <= length; at = buffer.indexOf(PATTERN, at + 1)) {
    const stamp = buffer.toString('latin1', at + PATTERN.length, at + MATCH_BYTES);
    const ms = STAMP_SHAPE.test(stamp) ? Date.parse(`${stamp}:00Z`) : Number.NaN;
    if (Number.isFinite(ms)) minutes.add(ms / MS_PER_MIN);
  }
}

/**
 * Scans path from offset (from 0 when the file is now shorter) and adds its active minutes.
 * @returns {number | null} the offset to store next time; null when the file vanished
 */
function scanFile(path, offset, minutes) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (MISSING_CODES.includes(error.code)) return null;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let position = size < offset ? 0 : offset;
    while (position < size) {
      const length = readSync(fd, buffer, 0, Math.min(READ_CHUNK_BYTES, size - position), position);
      if (length === 0) break;
      collectMinutes(buffer.subarray(0, length), length, minutes);
      if (position + length >= size) break;
      position += length - OVERLAP_BYTES;
    }
    return Math.max(0, size - OVERLAP_BYTES);
  } finally {
    closeSync(fd);
  }
}

/** Sorted [start, end) runs merged where they touch or overlap. */
function mergeRuns(runs) {
  const merged = [];
  for (const [start, end] of [...runs].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const runsOfMinutes = (minutes) => mergeRuns([...minutes].map((minute) => [minute, minute + 1]));

const isRun = (run) => Array.isArray(run) && run.length === 2 && run.every(Number.isInteger) && run[0] < run[1];
const isOffsetMap = (files) => files !== null && typeof files === 'object' && !Array.isArray(files)
  && Object.values(files).every((bytes) => Number.isInteger(bytes) && bytes >= 0);

/** The stored index of a session, or an empty one when there is none, it is unreadable or it has the wrong shape (then all is read again). */
function readIndex(stateDir, sessionId) {
  const empty = { v: INDEX_VERSION, files: {}, runs: [] };
  if (!stateDir) return empty;
  const text = readSessionFile(join(stateDir, ACTIVITY_FOLDER), sessionId, MAX_ACTIVITY_BYTES);
  if (typeof text !== 'string') return empty;
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    return empty; // a damaged index costs one full scan, never a wrong minute
  }
  const valid = index?.v === INDEX_VERSION && isOffsetMap(index.files) && Array.isArray(index.runs) && index.runs.every(isRun);
  return valid ? index : empty;
}

/** Brings one session's index up to date with its transcripts and stores it when a stateDir is given. */
function sessionRuns(sessionId, projectsDir, stateDir) {
  const index = readIndex(stateDir, sessionId);
  const minutes = new Set();
  const files = {};
  for (const path of sessionTranscripts(projectsDir, sessionId)) {
    const offset = scanFile(path, index.files[path] ?? 0, minutes);
    if (offset !== null) files[path] = offset;
  }
  const runs = mergeRuns([...index.runs, ...runsOfMinutes(minutes)]);
  if (stateDir) writeSessionFile(join(stateDir, ACTIVITY_FOLDER), sessionId, JSON.stringify({ v: INDEX_VERSION, files, runs }), { sweep: false });
  return runs;
}

/**
 * The active minutes of the given sessions as runs.
 * @param {string[]} sessionIds the sessions linked to a table; unsafe ids are skipped
 * @param {{ projectsDir: string, stateDir?: string | null }} options stateDir: the estimate state root (index under activity/);
 *   null or undefined reads every transcript from the start and stores nothing
 * @returns {[number, number][]} sorted, merged [startMin, endMin) runs of epoch minutes
 */
export function activeRuns(sessionIds, { projectsDir, stateDir }) {
  return mergeRuns(sessionIds.filter(isSessionId).flatMap((sessionId) => sessionRuns(sessionId, projectsDir, stateDir)));
}
