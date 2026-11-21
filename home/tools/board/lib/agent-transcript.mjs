// What one subagent transcript shows so far, read incrementally from a stored byte offset (research-tui 3.4 and 3.5): times, tool
// calls by kind (the milestones of the progress formula), the brief's numbered steps, the last tool call in words ("doing now"),
// whether a call is still waiting for its result, and whether the agent ended its turn.
// Exports: advanceCursor(cursor, file) -> cursor | null; emptyCursor(ino).
// Cursor: { ino, offset, startMs, lastMs, mtimeMs, calls, reads, edits, writes, checks, commits, reports, steps, lastTool:
// { name, text, atMs } | null, pending, endedMs, lastTextChars, cwd, shownPct, stepsSeen } (shownPct and stepsSeen belong to
// progress.mjs, kept here so they travel with the cursor).
// Format read (Claude Code 2.1.329, internal, observed): one JSON object per line with `timestamp`, `type` (user | assistant | ...),
// `cwd`, `message.content` (a string for the brief; blocks `tool_use` {name, input} and `tool_result`; `message.stop_reason`).
// Invariants: never throws (a file gone or unreadable returns the old cursor); reads at most MAX_READ_BYTES per call and only whole
// lines (the offset stops after the last newline, so a line being written is read next time); a line over MAX_PARSE_CHARS is not
// parsed, only its timestamp is taken; every text kept is stripped of control characters and cut.
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_PARSE_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 60;
const MAX_STEPS = 20;
const NEWLINE = 0x0a;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const TIMESTAMP = /"timestamp":"([0-9T:.\-]+Z?)"/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;
const CHECK = /\b(test|tests|vitest|jest|pytest|tsc|eslint|lint|typecheck|node --check|bash -n)\b/;
const REPORT_FILE = /report|-build\.md$|handover|handoff/i;
const NUMBERED_STEP = /^\s{0,3}(\d{1,2})[.)]\s+\S/gm;

const clean = (text) => String(text ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_TEXT_CHARS);

/** @returns {object} a cursor that has read nothing of the file with this inode */
export const emptyCursor = (ino) => ({
  ino, offset: 0, startMs: null, lastMs: null, mtimeMs: 0, calls: 0, reads: 0, edits: 0, writes: 0, checks: 0, commits: 0, reports: 0,
  steps: null, lastTool: null, pending: false, endedMs: null, lastTextChars: 0, cwd: null, shownPct: 0, stepsSeen: 0,
});

/** The brief's steps: the longest run 1..n of numbered lines (`1. ...`, `2) ...`), 0 when it has none. */
function stepsOf(brief) {
  const seen = new Set([...brief.matchAll(NUMBERED_STEP)].map((match) => Number(match[1])));
  let count = 0;
  while (count < MAX_STEPS && seen.has(count + 1)) count += 1;
  return count;
}

/** A tool call in words: Bash by its description, a file tool by the file's name, an agent by its description, the web by host. */
function toolText(name, input) {
  const file = typeof input?.file_path === 'string' ? basename(input.file_path) : typeof input?.notebook_path === 'string' ? basename(input.notebook_path) : null;
  if (name === 'Bash') return `Bash: ${clean(input?.description || String(input?.command ?? '').split(/\s+/).slice(0, 3).join(' '))}`;
  if (file !== null) return `${name} ${clean(file)}`;
  if (name === 'Agent' || name === 'Task') return `agent: ${clean(input?.description)}`;
  if (name === 'WebFetch') { try { return `web ${new URL(input.url).host}`; } catch { return 'web'; } }
  if (name === 'WebSearch') return `search ${clean(input?.query)}`;
  if (typeof input?.pattern === 'string') return `${name} ${clean(input.pattern)}`;
  return clean(name);
}

/** Counts one tool call into the cursor (mutates the cursor being built). */
function countCall(cursor, name, input, atMs) {
  cursor.calls += 1;
  const file = String(input?.file_path ?? '');
  if (name === 'Read') cursor.reads += 1;
  if (EDIT_TOOLS.has(name)) {
    cursor.edits += 1;
    if (name === 'Write') cursor.writes += 1;
    if (REPORT_FILE.test(file)) cursor.reports += 1;
  }
  if (name === 'Bash') {
    const command = String(input?.command ?? '');
    if (COMMIT.test(command)) cursor.commits += 1;
    else if (CHECK.test(command)) cursor.checks += 1;
  }
  cursor.lastTool = { name: clean(name), text: toolText(name, input), atMs };
  cursor.pending = true;
  cursor.endedMs = null;
}

/** Folds one parsed line into the cursor. */
function foldLine(cursor, line) {
  const atMs = Date.parse(line.timestamp ?? '');
  if (Number.isFinite(atMs)) {
    cursor.startMs ??= atMs;
    cursor.lastMs = Math.max(cursor.lastMs ?? atMs, atMs);
  }
  if (typeof line.cwd === 'string') cursor.cwd = line.cwd;
  const content = line.message?.content;
  if (line.type === 'user') {
    if (typeof content === 'string' && cursor.steps === null) cursor.steps = stepsOf(content);
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) cursor.pending = false;
    return;
  }
  if (line.type !== 'assistant' || !Array.isArray(content)) return;
  const calls = content.filter((block) => block?.type === 'tool_use');
  for (const call of calls) countCall(cursor, String(call.name ?? '?'), call.input, Number.isFinite(atMs) ? atMs : cursor.lastMs);
  const textChars = content.reduce((sum, block) => sum + (block?.type === 'text' ? String(block.text ?? '').length : 0), 0);
  if (textChars > 0) cursor.lastTextChars = textChars;
  if (calls.length === 0 && line.message?.stop_reason === 'end_turn') cursor.endedMs = Number.isFinite(atMs) ? atMs : cursor.lastMs;
}

/** Folds one raw line: parsed when small enough, else only its timestamp. */
function foldRaw(cursor, raw) {
  if (raw.length > MAX_PARSE_CHARS) {
    const atMs = Date.parse(TIMESTAMP.exec(raw.slice(0, MAX_PARSE_CHARS))?.[1] ?? '');
    if (Number.isFinite(atMs)) { cursor.startMs ??= atMs; cursor.lastMs = Math.max(cursor.lastMs ?? atMs, atMs); }
    return;
  }
  try {
    const line = JSON.parse(raw);
    if (line !== null && typeof line === 'object') foldLine(cursor, line);
  } catch {
    // not JSON (a line cut by a skip): nothing to count
  }
}

/** The new bytes of the file from `offset`, at most MAX_READ_BYTES. */
function readFrom(file, offset, size) {
  const length = Math.min(size - offset, MAX_READ_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, 'r');
  try {
    readSync(handle, buffer, 0, length, offset);
  } finally {
    closeSync(handle);
  }
  return buffer;
}

/**
 * The cursor after the file's new whole lines.
 * @param {object | undefined} cursor the stored cursor of this agent (a new one when missing or for another inode or a shorter file)
 * @param {string} file the transcript (a plain file; a link is refused)
 * @returns {object | null} the new cursor (a copy), or null when the file is not a plain file
 */
export function advanceCursor(cursor, file) {
  try {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile()) return null;
    const fresh = cursor === undefined || cursor === null || cursor.ino !== info.ino || info.size < cursor.offset;
    const next = { ...(fresh ? emptyCursor(info.ino) : cursor), lastTool: fresh ? null : cursor.lastTool, mtimeMs: info.mtimeMs };
    if (info.size === next.offset) return next;
    const buffer = readFrom(file, next.offset, info.size);
    const end = buffer.lastIndexOf(NEWLINE);
    if (end < 0) {
      if (buffer.length === MAX_READ_BYTES) next.offset += buffer.length; // one giant line: skip it, its rest is not JSON
      return next;
    }
    for (const raw of buffer.subarray(0, end).toString('utf8').split('\n')) if (raw) foldRaw(next, raw);
    next.offset += end + 1;
    return next;
  } catch {
    return cursor ?? null; // gone or unreadable while reading: the old facts stay
  }
}
