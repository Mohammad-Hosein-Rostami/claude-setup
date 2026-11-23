// What the estimate needs from one transcript, read incrementally from a stored cursor: its active minutes (for a subagent's own
// active minutes, row-agents.mjs) and the owner questions in it (AskUserQuestion tool_use to its tool_result, for pauses.mjs).
// Exports: readTranscriptFacts(file, cursor) -> cursor | null, asksOf(cursor) -> asks, emptyFacts(ino).
// Cursor: { v, ino, offset, lastMs, runs: [[startMin, endMin)], asks: [{ fromMs, toMs }], open: [{ id, fromMs }] } (epoch ms and
// epoch minutes). A subagent's transcript is <session folder>/subagents/agent-<id>.jsonl, the main one <projects>/<folder>/<session>.jsonl.
// Format read (Claude Code internal, as agent-transcript.mjs observes it): one JSON object per line with `timestamp`, `type` and
// `message.content` blocks `tool_use` { id, name } and `tool_result` { tool_use_id }.
// Invariants:
// - Huge files (F5): a run reads only the bytes after the cursor's offset, in READ_CHUNK_BYTES pieces, and holds at most one piece
//   plus MAX_LINE_BYTES of an unfinished line; a 400 MB transcript is never held whole. The offset stops after the last newline, so
//   a line being written is read whole next time; a line over MAX_LINE_BYTES gives only its timestamps (an ask is a small line).
// - An active minute is the UTC minute of any `"timestamp":"` match, as activity.mjs counts them (quoted text in a tool result is
//   escaped and does not match), so an agent's minutes agree with the session's.
// - Only plain files are read: a link, a FIFO, a folder or a file with a second hard link reads as no transcript (null). A stored
//   cursor of the wrong shape, another inode or a longer offset than the file starts over from byte 0 (one full scan, never a wrong fact).
// - An ask still open (no tool_result: the session ended or still waits) is closed by asksOf at the transcript's last entry (F3),
//   never left open to now; a live wait comes from the asking marker, which the caller adds.
import { fstatSync, readSync } from 'node:fs';
import { NOT_PLAIN_FILE, readPlainFileWith } from '../../../hooks/lib/plain-file.mjs';

const CURSOR_VERSION = 1;
const READ_CHUNK_BYTES = 1 << 20; // 1 MiB per read, as activity.mjs
const MAX_LINE_BYTES = 1 << 20; // an unfinished line held between reads; longer lines give their timestamps only
const MAX_RUNS = 10_000; // a week of minutes split by a silence every minute is about 5,000 runs
const MAX_ASKS = 500; // the 47 measured waits of the longest job (estimate spec R11), ten times over
const MAX_OPEN_ASKS = 16;
const STAMP = Buffer.from('"timestamp":"');
const STAMP_VALUE_BYTES = 32; // 2026-11-23T10:04:55.123Z is 24 bytes; a value is cut at its closing quote
const STAMP_WINDOW_BYTES = STAMP.length + STAMP_VALUE_BYTES; // kept from a long line's piece so a stamp cut by a read is seen whole
const ASK_TOOL = 'AskUserQuestion';
const ASK_BYTES = Buffer.from(`"${ASK_TOOL}"`);
const RESULT_BYTES = Buffer.from('"tool_use_id"');
const QUOTE = 0x22;
const NEWLINE = 0x0a;
const MS_PER_MIN = 60_000;
const NOT_PLAIN_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', NOT_PLAIN_FILE]);

/** @returns {object} a cursor that has read nothing of the file with this inode */
export const emptyFacts = (ino) => ({ v: CURSOR_VERSION, ino, offset: 0, lastMs: null, runs: [], asks: [], open: [] });

const isMs = (value) => Number.isFinite(value) && value >= 0;
const isRun = (run) => Array.isArray(run) && run.length === 2 && run.every(Number.isInteger) && run[0] < run[1];
const isAsk = (ask) => ask !== null && typeof ask === 'object' && isMs(ask.fromMs) && isMs(ask.toMs) && ask.toMs >= ask.fromMs;
const isOpenAsk = (ask) => ask !== null && typeof ask === 'object' && typeof ask.id === 'string' && isMs(ask.fromMs);

/** True for a stored cursor of this version and shape (C10: the cursor comes back from a file). */
function isCursor(cursor) {
  return cursor !== null && typeof cursor === 'object' && cursor.v === CURSOR_VERSION && Number.isInteger(cursor.offset)
    && cursor.offset >= 0 && Number.isFinite(cursor.ino) && (cursor.lastMs === null || isMs(cursor.lastMs))
    && Array.isArray(cursor.runs) && cursor.runs.every(isRun) && Array.isArray(cursor.asks) && cursor.asks.every(isAsk)
    && Array.isArray(cursor.open) && cursor.open.every(isOpenAsk);
}

/** Sorted [start, end) runs merged where they touch or overlap (activity.mjs keeps the same rule). */
function mergeRuns(runs) {
  const merged = [];
  for (const [start, end] of [...runs].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Adds every timestamp in bytes to the scan: its minute, and the newest time seen. */
function collectStamps(bytes, scan) {
  for (let at = bytes.indexOf(STAMP); at !== -1; at = bytes.indexOf(STAMP, at + 1)) {
    const valueStart = at + STAMP.length;
    const close = bytes.indexOf(QUOTE, valueStart);
    if (close === -1 || close - valueStart > STAMP_VALUE_BYTES) continue;
    const ms = Date.parse(bytes.toString('latin1', valueStart, close));
    if (!isMs(ms)) continue;
    scan.minutes.add(Math.floor(ms / MS_PER_MIN));
    scan.lastMs = Math.max(scan.lastMs ?? ms, ms);
  }
}

/** Folds the ask blocks of one parsed line: a tool_use opens an ask, the tool_result with its id closes it. */
function foldAsks(entry, scan) {
  const atMs = Date.parse(entry?.timestamp ?? '');
  const content = entry?.message?.content;
  if (!isMs(atMs) || !Array.isArray(content)) return;
  for (const block of content) {
    if (entry.type === 'assistant' && block?.type === 'tool_use' && block.name === ASK_TOOL && typeof block.id === 'string') {
      scan.open = [...scan.open, { id: block.id, fromMs: atMs }].slice(-MAX_OPEN_ASKS);
    }
    if (entry.type !== 'user' || block?.type !== 'tool_result') continue;
    const opened = scan.open.find((ask) => ask.id === block.tool_use_id);
    if (opened === undefined) continue;
    scan.asks = [...scan.asks, { fromMs: opened.fromMs, toMs: Math.max(opened.fromMs, atMs) }].slice(-MAX_ASKS);
    scan.open = scan.open.filter((ask) => ask !== opened);
  }
}

/** Folds one whole line: its timestamps, and its asks when it can hold one (only those lines are decoded). */
function foldLine(line, scan) {
  collectStamps(line, scan);
  const mayHoldAsk = line.includes(ASK_BYTES) || (scan.open.length > 0 && line.includes(RESULT_BYTES));
  if (!mayHoldAsk) return;
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return; // not JSON (a torn line of a killed writer): it holds no ask; its timestamps were already taken
  }
  foldAsks(entry, scan);
}

/** Reads the open file from `offset` to its end in pieces and folds every whole line; returns the offset after the last newline. */
function scanFrom(fd, size, offset, scan) {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let position = offset;
  let committed = offset;
  let pending = Buffer.alloc(0); // the start of a line that has not ended yet (or the tail of a long one)
  let longLine = false;
  while (position < size) {
    const length = readSync(fd, chunk, 0, Math.min(READ_CHUNK_BYTES, size - position), position);
    if (length === 0) break; // the file shrank while it was read: stop at what was read
    const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, length)]) : chunk.subarray(0, length);
    const dataStart = position - pending.length;
    position += length;
    let lineStart = 0;
    for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, lineStart)) {
      if (longLine) collectStamps(data.subarray(lineStart, end), scan);
      else foldLine(data.subarray(lineStart, end), scan);
      longLine = false;
      lineStart = end + 1;
      committed = dataStart + lineStart;
    }
    const rest = data.subarray(lineStart);
    longLine = longLine || rest.length > MAX_LINE_BYTES;
    if (longLine) collectStamps(rest, scan);
    pending = Buffer.from(longLine ? rest.subarray(Math.max(0, rest.length - STAMP_WINDOW_BYTES)) : rest);
  }
  return committed;
}

/** The cursor after the new whole lines of the open plain file. */
function advanceOpen(cursor, fd) {
  const info = fstatSync(fd);
  if (info.nlink > 1) return null; // a second hard link: the path may name one of the owner's other files
  const fresh = !isCursor(cursor) || cursor.ino !== info.ino || info.size < cursor.offset;
  const base = fresh ? emptyFacts(info.ino) : cursor;
  const scan = { minutes: new Set(), lastMs: base.lastMs, asks: base.asks, open: base.open };
  const offset = scanFrom(fd, info.size, base.offset, scan);
  const newRuns = [...scan.minutes].map((minute) => [minute, minute + 1]);
  const runs = mergeRuns([...base.runs, ...newRuns]).slice(-MAX_RUNS);
  return { v: CURSOR_VERSION, ino: info.ino, offset, lastMs: scan.lastMs, runs, asks: scan.asks, open: scan.open };
}

/**
 * The facts of one transcript after its new whole lines.
 * @param {string} file the transcript path
 * @param {object | null | undefined} cursor the stored cursor of this file (a new one when missing, of another shape or inode, or
 *   when the file is now shorter than its offset)
 * @returns {object | null} the new cursor (a new object; the given one is not changed), or null when the file is missing or not a
 *   plain file with one link
 * @throws {Error} other read errors (permissions), as activity.mjs does
 */
export function readTranscriptFacts(file, cursor) {
  try {
    return readPlainFileWith(file, (fd) => advanceOpen(cursor, fd));
  } catch (error) {
    if (NOT_PLAIN_CODES.has(error?.code)) return null;
    throw error;
  }
}

/**
 * The owner questions of a transcript as wait intervals (R11).
 * @param {object | null} cursor from readTranscriptFacts
 * @returns {{ fromMs: number, toMs: number }[]} answered asks, then the ones still open closed at the transcript's last entry (F3);
 *   [] for no cursor or one of the wrong shape
 */
export function asksOf(cursor) {
  if (!isCursor(cursor)) return [];
  const endMs = cursor.lastMs ?? 0;
  return [...cursor.asks, ...cursor.open.map((ask) => ({ fromMs: ask.fromMs, toMs: Math.max(ask.fromMs, endMs) }))];
}
