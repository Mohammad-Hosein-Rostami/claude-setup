// What one subagent transcript shows so far, read incrementally from a stored byte offset (research-tui 3.4 and 3.5): times, tool
// calls by kind (the milestones of the progress formula), the brief's numbered steps, the last tool call in words ("doing now"),
// whether a call is still waiting for its result, and whether the agent ended its turn.
// Exports: advanceCursor(cursor, file) -> cursor | null; emptyCursor(ino).
// Cursor: { ino, offset, startMs, lastMs, mtimeMs, calls, reads, edits, writes, checks, commits, reports, steps, tokens, lastTool:
// { name, text, atMs } | null, pending, endedMs, lastTextChars, cwd, changedDirs, pendingDirs, shownPct, stepsSeen }.
// changedDirs: the folders (newest first, at most MAX_DIRS) of the files the agent changed (Edit, Write, MultiEdit, NotebookEdit;
// not Bash: its cwd says nothing of where it writes, review C-1), counted only once the call's result came back without an error
// (a denied or failed call names nothing); pendingDirs holds them until then. They only MATCH an agent to a
// worktree of a repository the board already trusts (refresh.mjs); git never runs in them (review SEC-1 of 9ac483c3). A UNC or
// device path (`\\host`, `//host`) is never kept, so nothing ever touches another host. shownPct and stepsSeen belong to
// progress.mjs, kept here so they travel with the cursor).
// Format read (Claude Code 2.1.329, internal, observed): one JSON object per line with `timestamp`, `type` (user | assistant | ...),
// `cwd`, `message.content` (a string for the brief; blocks `tool_use` {name, input} and `tool_result`; `message.stop_reason`;
// `message.usage` on assistant lines). Tokens (spec-tui-2 stat 3) = the last assistant call's input, cache-write, cache-read and
// output tokens: the agent's context so far (a sum over calls would count the re-read context again on every call).
// Invariants: never throws (a file gone or unreadable returns the old cursor); reads at most MAX_READ_BYTES per call and only whole
// lines (the offset stops after the last newline, so a line being written is read next time); a line over MAX_PARSE_CHARS is not
// parsed, only its timestamp is taken; every text kept is stripped of control characters and cut.
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_PARSE_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 60;
const MAX_STEPS = 20;
const MAX_PATH_CHARS = 1024;
const MAX_DIRS = 4;
const MAX_PENDING = 16;
const REMOTE_PATH = /^(\\\\|\/\/)/; // UNC `\\host\share` or `//host/share`: never a folder of this machine
const NEWLINE = 0x0a;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const TIMESTAMP = /"timestamp":"([0-9T:.\-]+Z?)"/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMIT = /\bgit\b[^|;&\n]*?\bcommit\b/g; // every commit of a chained command counts (writers commit after each step)
const CHECK = /\b(test|tests|vitest|jest|pytest|tsc|eslint|lint|typecheck|node --check|bash -n)\b/;
const REPORT_FILE = /report|-build\.md$|handover|handoff/i;
const NUMBERED_STEP = /^\s{0,3}(\d{1,2})[.)]\s+\S/gm;

const clean = (text) => String(text ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_TEXT_CHARS);

/** @returns {object} a cursor that has read nothing of the file with this inode */
export const emptyCursor = (ino) => ({
  ino, offset: 0, startMs: null, lastMs: null, mtimeMs: 0, calls: 0, reads: 0, edits: 0, writes: 0, checks: 0, commits: 0, reports: 0,
  steps: null, tokens: 0, lastTool: null, pending: false, endedMs: null, lastTextChars: 0, cwd: null, changedDirs: [],
  pendingDirs: {}, shownPct: 0, stepsSeen: 0,
});

const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

/** @returns {number | null} the tokens of one call's usage, or null when the line has none */
function tokensOf(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const sum = USAGE_KEYS.reduce((acc, key) => acc + (Number.isFinite(usage[key]) ? usage[key] : 0), 0);
  return sum > 0 ? sum : null;
}

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
    const commits = command.match(COMMIT)?.length ?? 0;
    if (commits > 0) cursor.commits += commits;
    else if (CHECK.test(command)) cursor.checks += 1;
  }
  cursor.lastTool = { name: clean(name), text: toolText(name, input), atMs };
  cursor.pending = true;
  cursor.endedMs = null;
}

/** @returns {string | null} a local absolute folder (not UNC, not too long), else null */
const localDir = (path) => (typeof path === 'string' && path.length <= MAX_PATH_CHARS && isAbsolute(path) && !REMOTE_PATH.test(path) ? path : null);

/** The folder of the file an edit call changes, held until its result. */
function holdDir(cursor, call) {
  if (!EDIT_TOOLS.has(String(call.name ?? '')) || typeof call.id !== 'string') return;
  const path = call.input?.file_path ?? call.input?.notebook_path;
  const dir = localDir(typeof path === 'string' ? dirname(path) : null);
  if (dir === null) return;
  const ids = Object.keys(cursor.pendingDirs);
  if (ids.length >= MAX_PENDING) delete cursor.pendingDirs[ids[0]];
  cursor.pendingDirs[call.id] = dir;
}

/** Each result that came back without an error moves its call's folder to the front of its list. */
function settleDirs(cursor, content) {
  for (const block of content.filter((item) => item?.type === 'tool_result' && typeof item.tool_use_id === 'string')) {
    const held = cursor.pendingDirs[block.tool_use_id];
    if (typeof held !== 'string') continue; // none, or an entry of an older cursor shape
    delete cursor.pendingDirs[block.tool_use_id];
    if (block.is_error === true) continue;
    cursor.changedDirs = [held, ...(cursor.changedDirs ?? []).filter((dir) => dir !== held)].slice(0, MAX_DIRS);
  }
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
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      cursor.pending = false;
      settleDirs(cursor, content);
    }
    return;
  }
  if (line.type !== 'assistant' || !Array.isArray(content)) return;
  cursor.tokens = tokensOf(line.message?.usage) ?? cursor.tokens ?? 0;
  const calls = content.filter((block) => block?.type === 'tool_use');
  for (const call of calls) {
    countCall(cursor, String(call.name ?? '?'), call.input, Number.isFinite(atMs) ? atMs : cursor.lastMs);
    holdDir(cursor, call);
  }
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
    const base = fresh ? emptyCursor(info.ino) : cursor;
    // copies of the lists, so a cursor read from the cache is never changed in place; old cursors have none
    const next = { ...base, lastTool: fresh ? null : cursor.lastTool, mtimeMs: info.mtimeMs, changedDirs: [...(base.changedDirs ?? [])],
      pendingDirs: { ...(base.pendingDirs ?? {}) } };
    delete next.fileDir; // fields of older cursor shapes
    delete next.readDirs;
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
