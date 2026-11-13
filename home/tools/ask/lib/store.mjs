// File I/O of the decision queue: path confinement, creation and pruning, locking, appending and incremental reads.
// Exports: UsageError, askDir(), QUEUE_NAME, confineQueue(path), createQueue(), withLock(realPath, fn),
// appendRecord(realPath, record), readQueue(realPath), readNew(realPath, offset, discarding), plus the constants PRUNE_AGE_MS,
// MAX_READ_BYTES and MAX_LINE_BYTES.
// Invariants: a queue path is used only after its real path is a regular file named like `init` names it, directly inside
// the real ~/.claude/ask (a symlink, a hardlink (nlink > 1) or a path elsewhere is refused, at the check and again on the
// opened descriptor); appends open with O_APPEND|O_NOFOLLOW and never
// create a file; ids are assigned by the caller under `withLock` (a mkdir lock with a stale timeout); `readNew` returns
// whole lines only and never reads more than MAX_READ_BYTES at once; an over-long line is dropped through its next
// newline, so nothing from its tail is ever parsed.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MAX_LINE_CHARS, parse } from './queue.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RANDOM_BYTES = 3; // 6 hex chars
const DAY_MS = 86_400_000;
export const PRUNE_AGE_MS = 14 * DAY_MS;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = MAX_LINE_CHARS * 4; // a char is at most 4 UTF-8 bytes
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10_000;
/** The file name `init` gives a queue: UTC date, time and 6 hex chars. */
export const QUEUE_NAME = /^\d{8}-\d{6}-[0-9a-f]{6}\.jsonl$/;

/** A mistake of the caller (bad flag, path, id or input): the CLI prints it and exits 2. */
export class UsageError extends Error {}

/** @returns {string} the directory that holds every queue, `~/.claude/ask` */
export const askDir = () => join(homedir(), '.claude', 'ask');

const utcStamp = () => new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

/**
 * Resolve a `--queue` / `ASK_QUEUE` path to the real file it names, or refuse it.
 * @param {string} path the path as given
 * @returns {string} the real path, safe to open for append or read
 * @throws {UsageError} when the file is missing, is not a plain file made by `init`, or lies outside ~/.claude/ask
 */
export function confineQueue(path) {
  let dir;
  try {
    dir = realpathSync.native(askDir());
  } catch {
    throw new UsageError(`no queue directory ${askDir()}: run \`ask.mjs init\` first`);
  }
  let real;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new UsageError(`queue file not found: ${path} (post never creates one; run \`ask.mjs init\`)`);
  }
  if (dirname(real) !== dir || !QUEUE_NAME.test(basename(real)) || !statSync(real).isFile()) {
    throw new UsageError(`queue path must be a file made by \`ask.mjs init\` inside ${dir}: ${path}`);
  }
  if (statSync(real).nlink > 1) throw new UsageError(`queue file has more than one hard link, refused: ${path}`);
  return real;
}

// Open a queue without following a symlink and re-check the opened file (a hardlink made after `confineQueue` is refused).
function openQueue(realPath, flags) {
  const fd = openSync(realPath, flags | (constants.O_NOFOLLOW ?? 0));
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink > 1) {
    closeSync(fd);
    throw new UsageError(`queue file is not a plain single-link file, refused: ${realPath}`);
  }
  return fd;
}

// Delete queue files older than PRUNE_AGE_MS; anything else in the folder is left alone.
function pruneOld(dir) {
  for (const name of readdirSync(dir).filter((n) => QUEUE_NAME.test(n))) {
    const file = join(dir, name);
    const info = lstatSync(file);
    if (info.isFile() && Date.now() - info.mtimeMs > PRUNE_AGE_MS) unlinkSync(file);
  }
}

/**
 * Create a new empty queue (dir 0700, file 0600) and prune queue files older than 14 days.
 * @returns {string} the path of the new queue
 */
export function createQueue() {
  const dir = askDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  pruneOld(dir);
  const path = join(dir, `${utcStamp()}-${randomBytes(RANDOM_BYTES).toString('hex')}.jsonl`);
  writeFileSync(path, '', { mode: FILE_MODE, flag: 'wx' });
  return path;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// True when the lock directory is gone or was old enough to remove, so the caller should retry at once.
function clearStaleLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
    rmSync(lock, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true; // released between the failed mkdir and now
    throw err;
  }
}

/**
 * Run `fn` holding the queue's exclusive lock (a `<queue>.lock` directory), so ids are assigned one at a time.
 * @param {string} realPath real path of the queue
 * @param {() => T} fn the critical section
 * @returns {T} what `fn` returns
 * @throws {UsageError} when the lock stays held longer than 5 s and is not stale
 * @template T
 */
export function withLock(realPath, fn) {
  const lock = `${realPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: DIR_MODE });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (clearStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new UsageError(`queue is locked by another process: ${lock}`);
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Append one JSON line (with a timestamp) to an existing queue; never creates the file and never follows a symlink.
 * @param {string} realPath real path from `confineQueue`
 * @param {object} record the record to store
 * @throws {UsageError} when the serialized line is longer than MAX_LINE_CHARS, or the file is not a plain single-link file
 */
export function appendRecord(realPath, record) {
  const line = JSON.stringify({ ...record, ts: new Date().toISOString() });
  // The reader drops lines over MAX_LINE_CHARS, so a longer one (JSON escaping can inflate control characters) is refused.
  if (line.length > MAX_LINE_CHARS) throw new UsageError(`the line is ${line.length} chars once escaped, over the limit of ${MAX_LINE_CHARS}; shorten the text`);
  const fd = openQueue(realPath, constants.O_WRONLY | constants.O_APPEND);
  try {
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and parse a whole queue; one stderr line when lines were skipped.
 * @param {string} realPath real path from `confineQueue`
 * @returns {object[]} the valid records
 */
export function readQueue(realPath) {
  const fd = openQueue(realPath, constants.O_RDONLY);
  let text;
  try {
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const { records, malformed } = parse(text);
  if (malformed) process.stderr.write(`ask: skipped ${malformed} malformed line(s) in ${realPath}\n`);
  return records;
}

/**
 * Read the complete lines after a byte offset, at most MAX_READ_BYTES per call.
 * @param {string} realPath real path from `confineQueue`
 * @param {number} offset byte offset of the first unread byte
 * @param {boolean} [discarding] true while the previous call was inside an over-long line: bytes up to the next newline
 *   are dropped, never parsed
 * @returns {{lines: string[], offset: number, eof: boolean, reset: boolean, skipped: boolean, discarding: boolean}}
 *   `reset` is true when the file got shorter (read restarted at 0); `skipped` when an over-long line was dropped;
 *   `discarding` must be passed back in; `eof` when nothing more can be read right now (a trailing partial line
 *   waits for its newline)
 */
export function readNew(realPath, offset, discarding = false) {
  const size = statSync(realPath).size;
  const reset = size < offset;
  const start = reset ? 0 : offset;
  const length = Math.min(size - start, MAX_READ_BYTES);
  const result = { lines: [], offset: start, eof: start + length >= size, reset, skipped: false, discarding: discarding && !reset };
  if (length === 0) return result;
  const buf = Buffer.alloc(length);
  const fd = openQueue(realPath, constants.O_RDONLY);
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  let from = 0;
  if (result.discarding) {
    const newline = buf.indexOf(0x0a);
    if (newline < 0) return Object.assign(result, { offset: start + length }); // still inside the dropped line
    from = newline + 1;
    result.discarding = false;
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < from) {
    const waiting = length - from; // a partial line: it waits for its newline unless it is already too long
    if (waiting >= MAX_LINE_BYTES) Object.assign(result, { offset: start + length, skipped: true, discarding: true });
    else result.offset = start + from;
    return result;
  }
  result.lines = buf.subarray(from, lastNewline).toString('utf8').split('\n');
  result.offset = start + lastNewline + 1;
  return result;
}
