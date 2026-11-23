// The job-made record: what a job made that may be left behind (a lane folder, an artefact folder, a download, a log, a screenshot,
// a docker container, volume or image), so the job-leftover sweep removes only what a job of this setup made, never on size alone.
// Exports: JOB_MADE_KINDS, RECORD_VERSION, MAX_RECORD_FILE_BYTES, MAX_RECORD_LINE_BYTES, STALE_AFTER_MS, jobMadeFolder,
//   recordJobMade, readJobMade, stillMade.
// Store: one append-only file per session, <HOME>/.claude/state/job-made/<session>.jsonl, one JSON line per event:
//   {"v":1,"op":"made"|"gone","at":<ms>,"kind":<kind>,"key":<path or docker id/name>,"by":<the tool that wrote it>}
//   and, once, {"v":1,"op":"full","at":<ms>} when the file reached its cap.
// Primitives reused (P16): hooks/lib/plain-file.mjs appends (no link followed, no FIFO waited on, 0600) and reads within a cap;
//   hooks/lib/session-store.mjs checks the folder (0700, owned by this user) and the session id; hooks/lib/session-lock.mjs lets two
//   writers of one session take turns, so the cap check, the torn-line repair and the append are one step.
// Invariants:
// - One cap for writer and reader (P6): a record line is appended only while the file stays within MAX_RECORD_FILE_BYTES minus the
//   room of the full line; the first line that does not fit writes the full line instead (said once, in the file and as 'filled');
//   later calls write nothing and return 'full'. Nothing is ever cut or rewritten.
// - Two sessions write two files (F1); two writers of one session take turns under the session lock, so no line is lost or mixed.
// - Torn line (a writer killed mid-append): the next append starts on a new line; a reader skips the broken part and counts it.
// - Old reader: a line of a newer version or an unknown kind is skipped and counted, never guessed at; extra fields are dropped.
// - A key is stored only as a JSON string (a path with a newline or a docker name with spaces stays one value); this module
//   never passes a key to a shell or a command (F2). Docker kinds take any text. A path kind needs an absolute path with no `..` part
//   (after a linked folder `..` is not lexical, so it is refused, never resolved); it is written and compared without `.` parts,
//   doubled or trailing separators, so `/r/./lane-1/` and `/r/lane-1` are one key.
// - A hard-linked record file (nlink > 1: another name of the same file, maybe one of the owner's) is neither appended to nor read.
// - Clock step: within one session the later line in the file wins whatever its time; across sessions the newer `at` wins.
// - Stale record: a session whose newest line is over STALE_AFTER_MS old reads as `stale`; the writer never deletes or trims a
//   record file, the sweep drops stale ones (F3, P15).
// - Nothing here throws: a writer that cannot write returns 'unwritable', a reader that cannot read says why.
import { fstatSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse, sep } from 'node:path';
import { appendPlainFile, NOT_PLAIN_FILE, readPlainFileWith } from '../../../hooks/lib/plain-file.mjs';
import { withSessionLock } from '../../../hooks/lib/session-lock.mjs';
import { isPrivateFile, isSessionId, lstatOrNull, privateFolder } from '../../../hooks/lib/session-store.mjs';

/** What a record can name. Path kinds hold an absolute path; the docker kinds a container, volume or image id or name. */
export const JOB_MADE_KINDS = Object.freeze(['lane-folder', 'artefacts', 'download', 'log', 'screenshot', 'container', 'volume', 'image']);
const PATH_KINDS = new Set(['lane-folder', 'artefacts', 'download', 'log', 'screenshot']);
const RECORD_OPS = new Set(['made', 'gone']);
const FULL_OP = 'full';
export const RECORD_VERSION = 1;
export const MAX_RECORD_FILE_BYTES = 1024 * 1024; // per session; a record line of a long path is about 300 bytes, so ~3,000 records
export const MAX_RECORD_LINE_BYTES = 16 * 1024; // a key of MAX_KEY_CHARS escaped (\uXXXX per char at worst) still has to fit
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days without a new line: the sweep drops the session's record
const FULL_LINE_ROOM_BYTES = 128; // kept free for the full line `{"v":1,"op":"full","at":<13 digits>}\n` (about 40 bytes) and a repair
const TAIL_BYTES = 256; // read from the end to find a torn last line or the full line
const MAX_KEY_CHARS = 2048;
const MAX_BY_CHARS = 100;
const RECORD_FILE = /^([A-Za-z0-9_-]{1,100})\.jsonl$/; // the session ids isSessionId accepts, plus the extension
const PATH_PARTS = sep === '\\' ? /[\\/]/ : /\//; // Windows takes both separators; on POSIX a backslash is part of a name
const PARENT_PART = '..';

/** @returns {string} the record folder under the HOME of env (USERPROFILE on Windows) */
export const jobMadeFolder = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'job-made');

const textWithin = (value, maxChars) => typeof value === 'string' && value.length > 0 && value.length <= maxChars;

/**
 * The form a key is written and compared in, or null when it cannot name a thing of this kind. A docker key stays as given; a path
 * key must be absolute with no `..` part and loses its `.` parts, doubled and trailing separators (the root keeps its own).
 */
function storedKey(kind, key) {
  if (!textWithin(key, MAX_KEY_CHARS)) return null;
  if (!PATH_KINDS.has(kind)) return key;
  if (!isAbsolute(key) || key.split(PATH_PARTS).includes(PARENT_PART)) return null;
  const normal = normalize(key);
  return normal.endsWith(sep) && normal !== parse(normal).root ? normal.slice(0, -sep.length) : normal;
}

/** The JSON line of one event, or null when the entry is not a record this version writes. */
function recordLine({ kind, key, by, op = 'made' }, now) {
  const stored = JOB_MADE_KINDS.includes(kind) ? storedKey(kind, key) : null;
  const valid = stored !== null && RECORD_OPS.has(op) && textWithin(by, MAX_BY_CHARS);
  if (!valid || !Number.isFinite(now)) return null;
  const line = `${JSON.stringify({ v: RECORD_VERSION, op, at: now, kind, key: stored, by })}\n`;
  return Buffer.byteLength(line) <= MAX_RECORD_LINE_BYTES ? line : null;
}

/** The last TAIL_BYTES of the file and whether they start at its first byte; an empty text for a missing file. */
function tailOf(path) {
  try {
    return readPlainFileWith(path, (fd, size) => {
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      return { text: buffer.toString('utf8', 0, read), fromStart: length === size };
    });
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '', fromStart: true };
    throw error; // a link, a FIFO, a folder: withSessionLock turns it into 'unwritable'
  }
}

/** True when the last whole line of the tail is the full line. */
function endsWithFullLine({ text, fromStart }) {
  if (!text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 && !fromStart) return false; // the last line began before the tail: far longer than a full line
  return parseLine(lines.at(-1))?.op === FULL_OP;
}

/** Appends one line under the session lock: 'recorded', 'filled' (the full line was written now) or 'full'. */
function appendRecord(path, line, now) {
  const tail = tailOf(path);
  if (endsWithFullLine(tail)) return 'full';
  const repair = tail.text !== '' && !tail.text.endsWith('\n') ? '\n' : ''; // a torn last line stays apart from the new one
  if (appendPlainFile(path, `${repair}${line}`, { maxBytes: MAX_RECORD_FILE_BYTES - FULL_LINE_ROOM_BYTES })) return 'recorded';
  const fullLine = `${repair}${JSON.stringify({ v: RECORD_VERSION, op: FULL_OP, at: now })}\n`;
  return appendPlainFile(path, fullLine, { maxBytes: MAX_RECORD_FILE_BYTES }) ? 'filled' : 'unwritable';
}

/**
 * Records that a job of this session made something (op 'made', the default) or removed it (op 'gone').
 * Why: the job-leftover sweep removes only what a record or the setup's own markers name (fixes-spec revision 2, D5).
 * @param {NodeJS.ProcessEnv} env HOME (USERPROFILE on Windows) names the store
 * @param {string} session the Claude Code session id (see isSessionId)
 * @param {{kind: string, key: string, by: string, op?: 'made'|'gone'}} entry kind from JOB_MADE_KINDS; key an absolute path for the
 *   path kinds, a docker id or name for the docker kinds; by the tool that writes it, such as 'git-tidy lane claim'
 * @param {{now?: number}} [options] the event's time in ms (Date.now() by default)
 * @returns {'recorded'|'filled'|'full'|'refused'|'unwritable'} 'filled': this call found the file at its cap and wrote the full line
 *   (tell the owner once); 'full': it was full before, nothing written; 'refused': a bad session id or entry; 'unwritable': the
 *   store is a link, FIFO or foreign folder, the lock stayed busy for a second, or the write failed
 */
export function recordJobMade(env, session, entry, { now = Date.now() } = {}) {
  const line = entry !== null && typeof entry === 'object' ? recordLine(entry, now) : null;
  if (!isSessionId(session) || line === null) return 'refused';
  const dir = jobMadeFolder(env);
  return withSessionLock(dir, session, () => appendRecord(join(dir, `${session}.jsonl`), line, now)) ?? 'unwritable';
}

/** One line of a record file: an event, the full line, or null for text this version does not know (torn, newer, planted). */
function parseLine(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null; // a torn or foreign line: the caller counts it
  }
  if (value === null || typeof value !== 'object' || value.v !== RECORD_VERSION || !Number.isFinite(value.at)) return null;
  if (value.op === FULL_OP) return { op: FULL_OP, at: value.at };
  const key = RECORD_OPS.has(value.op) && JOB_MADE_KINDS.includes(value.kind) ? storedKey(value.kind, value.key) : null;
  if (key === null || !textWithin(value.by, MAX_BY_CHARS)) return null;
  return { op: value.op, at: value.at, kind: value.kind, key, by: value.by };
}

/** The events of a record file's text, how many parts were skipped, and whether the full line is there. */
function parseRecordText(text) {
  const events = [];
  let skipped = 0;
  let full = false;
  for (const part of text.split('\n')) {
    if (part === '') continue;
    const line = parseLine(part);
    if (line === null) skipped += 1;
    else if (line.op === FULL_OP) full = true;
    else events.push(line);
  }
  return { events, skipped, full };
}

/** True for this user's regular file with no second hard link (a planted `ln` of one of the owner's files has two). */
const isSingleLinkPrivateFile = (stats) => isPrivateFile(stats) && stats.nlink === 1;

/** A record file's text, read through one open checked again: a hard link or a big file swapped in after the lstat is refused. */
function readRecordText(path) {
  return readPlainFileWith(path, (fd, size) => {
    if (!isSingleLinkPrivateFile(fstatSync(fd)) || size > MAX_RECORD_FILE_BYTES) {
      throw Object.assign(new Error(`${path}: not a single-link file of this user within ${MAX_RECORD_FILE_BYTES} bytes`), { code: NOT_PLAIN_FILE });
    }
    const buffer = Buffer.alloc(size);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, size, 0));
  });
}

/** The record of one session file; `usable: false` with why when it is not a private single-link plain file within the cap. */
function readSessionRecord(dir, session, now) {
  const path = join(dir, `${session}.jsonl`);
  try {
    const stats = lstatOrNull(path);
    if (stats === null || !isSingleLinkPrivateFile(stats)) return { session, usable: false, why: 'not a single-link plain file of this user' };
    const { events, skipped, full } = parseRecordText(readRecordText(path));
    const lastAt = events.length === 0 ? stats.mtimeMs : Math.max(...events.map((event) => event.at));
    return { session, usable: true, events, skipped, full, lastAt, stale: now - lastAt > STALE_AFTER_MS };
  } catch (error) {
    return { session, usable: false, why: error.code ?? error.message };
  }
}

/**
 * Reads every session's record. Read only: it never creates, trims or deletes a file.
 * @param {NodeJS.ProcessEnv} env HOME (USERPROFILE on Windows) names the store
 * @param {{now?: number}} [options] the time staleness is judged at (Date.now() by default)
 * @returns {{usable: boolean, why?: string, sessions: Array<{session: string, usable: boolean, why?: string,
 *   events?: Array<{op: 'made'|'gone', at: number, kind: string, key: string, by: string}>, skipped?: number, full?: boolean,
 *   lastAt?: number, stale?: boolean}>}} sessions sorted by id; a missing folder is usable and empty; a folder that is a link or
 *   another user's is not usable (the sweep then trusts no record); `skipped` counts torn and unknown lines; `full`: the file hit
 *   its cap, so later events of that session are missing; `stale`: the newest event (else the file's mtime) is over STALE_AFTER_MS old
 */
export function readJobMade(env, { now = Date.now() } = {}) {
  const dir = jobMadeFolder(env);
  try {
    if (lstatOrNull(dir) === null) return { usable: true, sessions: [] };
    if (privateFolder(dir) === undefined) return { usable: false, why: 'record folder is not a folder of this user', sessions: [] };
    const sessions = readdirSync(dir)
      .map((name) => RECORD_FILE.exec(name)?.[1])
      .filter((session) => session !== undefined)
      .sort()
      .map((session) => readSessionRecord(dir, session, now));
    return { usable: true, sessions };
  } catch (error) {
    return { usable: false, why: error.code ?? error.message, sessions: [] };
  }
}

/**
 * What the records say is still there: per kind and key, the newest event over all given sessions, kept when it is 'made'.
 * Within one session the later line in its file wins whatever its `at` (the clock may step back, the append order may not); across
 * sessions the larger `at` wins, and a 'made' and a 'gone' at the same ms count as gone (the safe side: the sweep leaves it alone).
 * @param {ReturnType<typeof readJobMade>['sessions']} sessions as readJobMade returns them (pass only the fresh ones to leave stale out)
 * @returns {Array<{kind: string, key: string, by: string, at: number, session: string}>} sorted by kind, then key
 */
export function stillMade(sessions) {
  const newest = new Map();
  for (const record of sessions.filter((one) => one.usable)) {
    for (const [id, event] of lastLinePerKey(record.events)) {
      const before = newest.get(id);
      const newer = before === undefined || event.at > before.at || (event.at === before.at && event.op === 'gone');
      if (newer) newest.set(id, { ...event, session: record.session });
    }
  }
  return [...newest.values()]
    .filter((event) => event.op === 'made')
    .map(({ kind, key, by, at, session }) => ({ kind, key, by, at, session }))
    .sort((a, b) => compareText(a.kind, b.kind) || compareText(a.key, b.key));
}

/** Per kind and key, the last of a session's events in file order (a later entry of one id replaces the earlier one). */
const lastLinePerKey = (events) => new Map(events.map((event) => [JSON.stringify([event.kind, event.key]), event]));

/** Code-unit order, the same on every machine (localeCompare is not). */
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
