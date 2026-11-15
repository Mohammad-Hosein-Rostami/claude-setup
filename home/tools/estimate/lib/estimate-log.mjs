// The calibration log of one STATUS.md: where it lives, reading it, and writing it back trimmed.
// Exports: readLog(statusPath, dir?) -> entries; writeLog(statusPath, entries, dir?) -> boolean; logDir(); logFile(statusPath, dir?);
// MAX_LOG_BYTES; MAX_LOG_ENTRIES.
// Invariants:
// - Location: ~/.claude/state/estimate-log/<first 32 hex of sha256(absolute STATUS.md path)>.json, outside every repo. One JSON
//   entry per line (see calibration.mjs): ids and numbers only, never item text, prompts or transcript content.
// - Opened and replaced through hooks/lib/session-store.mjs: no links, 0600, a new temp file renamed over the old one, so two
//   racing runs can lose one line but never leave a broken file. Written with { sweep: false }: the store's 7-day cleanup is
//   for per-session state, while this log is calibration history that must outlive a project paused for weeks. Reusing the
//   store (rather than a second copy of its link-safe reads and writes) keeps one audited implementation; its folder holds
//   only these logs, so no other store's sweep reaches it.
// - The whole file is rewritten on each write, keeping the last MAX_LOG_ENTRIES entries within MAX_LOG_BYTES.
// - A line that is not a valid entry of this STATUS.md is left out on read; nothing here throws or prints.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';

export const MAX_LOG_BYTES = 131_072; // 200 entries of ~300 bytes fit with room; a bigger file was not written by this tool
export const MAX_LOG_ENTRIES = 200; // older entries no longer move the factors (they use the last 10 scored) or the track record much
const LOG_ID_HEX_CHARS = 32;
const RANGE_LENGTH = 2;

/** @returns {string} the default log folder (under ~/.claude/state, like the other stores) */
export const logDir = () => join(homedir(), '.claude', 'state', 'estimate-log');

const logId = (statusPath) => createHash('sha256').update(statusPath).digest('hex').slice(0, LOG_ID_HEX_CHARS);

/** @returns {string} the log file of a STATUS.md (absolute path) in a folder */
export const logFile = (statusPath, dir = logDir()) => join(dir, `${logId(statusPath)}.json`);

const isPair = (value, type) => Array.isArray(value) && value.length === RANGE_LENGTH && value.every((v) => typeof v === type);
const isInstant = (text) => typeof text === 'string' && Number.isFinite(Date.parse(text));

/** True for a well-formed entry of this STATUS.md (the fields calibration.mjs writes and reads). */
function isEntry(entry, statusPath) {
  return entry?.v === 1 && entry.status === statusPath && isInstant(entry.at)
    && Array.isArray(entry.open) && entry.open.every((id) => typeof id === 'string')
    && typeof entry.points === 'number' && isPair(entry.raw, 'number') && isPair(entry.printed, 'string') && entry.printed.every(isInstant)
    && (entry.actual === undefined || entry.actual === 'void' || isInstant(entry.actual));
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a torn or foreign line: not an entry, the next write drops it
  }
}

/**
 * @param {string} statusPath absolute path of the STATUS.md.
 * @param {string} [dir] the log folder (default ~/.claude/state/estimate-log).
 * @returns {object[]} the valid entries, oldest first; [] when there is no log or it cannot be used.
 */
export function readLog(statusPath, dir = logDir()) {
  const text = readSessionFile(dir, logId(statusPath), MAX_LOG_BYTES);
  if (typeof text !== 'string') return [];
  return text.split('\n').filter((line) => line.trim() !== '').map(parseLine).filter((entry) => isEntry(entry, statusPath));
}

/**
 * Rewrites the log with the last MAX_LOG_ENTRIES entries, dropping the oldest until it fits MAX_LOG_BYTES.
 * @param {string} statusPath absolute path of the STATUS.md.
 * @param {object[]} entries all entries to keep, oldest first.
 * @param {string} [dir] the log folder.
 * @returns {boolean} true when stored; false when the store is unusable (a link, another owner) or the write failed.
 */
export function writeLog(statusPath, entries, dir = logDir()) {
  const lines = entries.slice(-MAX_LOG_ENTRIES).map((entry) => JSON.stringify(entry));
  while (lines.length > 0 && Buffer.byteLength(`${lines.join('\n')}\n`) > MAX_LOG_BYTES) lines.shift();
  return writeSessionFile(dir, logId(statusPath), `${lines.join('\n')}\n`, { sweep: false });
}
