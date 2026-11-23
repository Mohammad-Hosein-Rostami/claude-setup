// The last-seen usage limits per account: the status line render writes a sample when the status input's `rate_limits` brought
// news; the estimate (reset times beside a long job), the board and the pane read them. One format, one owner (display design 4.6
// rows 1 and 11; spec-p5 `r9-board` "Limit samples per account"; fixes-spec X12 for many sessions on one account).
// Exports: limitsDir(), isAccountName(name), readLimits(account, deps) -> { account, samples } | null, latestSample(file) -> sample | null,
// recordSample(account, rateLimits, deps) -> boolean; MAX_SAMPLES, LOG_KEEP_MS, MAX_LOG_BYTES.
// Files: ~/.claude/state/limits/<account>.json = { account, samples: [{ t, session?, five_hour, seven_day }] } (oldest first, at most
// MAX_SAMPLES; each window { used_percentage, resets_at } as the status input gives it, resets_at in epoch seconds, or null when the
// input had none; `session` is the writing session's id, absent in samples written before it was stored), < 8 KB, temp file and
// rename; ~/.claude/state/limits/<account>.jsonl = one sample per line, appended; <account>.lock while a session stores a sample.
// Invariants:
// - No account name, no file (a sample with no account would mix accounts); a gap is never filled by a guess; nothing here throws
//   (any failure reads as no file, or a write that returns false).
// - Many sessions on one account write at once, each with its own view of the limits, some older than others. A sample is stored
//   only when it is news and behind the stored limits in no window (see isNews), so an older view never undoes a newer one (two
//   sessions alternating 43% and 63% of one window stored the sawtooth before). Each window is compared with the newest stored
//   sample that has that window, so a sample without the 5-hour window does not let an older 5-hour value back in. The check and
//   the write run under the account's lock (hooks/lib/session-lock.mjs), so two sessions never both store against the same newest
//   sample.
// - The render never waits on that lock (board README: render under 50 ms): it is tried once, and when it is held the sample is
//   dropped (the next render, about 5 s later, tries again). A lock left by a killed holder is removed by session-lock's stale rules
//   (a gone pid after 0.5 s, any lock after 5 s), never one whose holder still runs.
// - The log line is one O_APPEND write through hooks/lib/plain-file.mjs: no link followed, no FIFO waited on, and never into a file
//   with a second hard link (a rewrite renames a new file over the name and leaves the linked file as it was). A torn last line (a
//   writer killed mid-line) gets a line break first, so the next line stays whole and the torn one is dropped at the next rewrite.
// - The log never passes MAX_LOG_BYTES, the byte cap its writer and readers share: before a line would pass it, the log is rewritten
//   to its newest half. It is also rewritten once its first line is LOG_TRIM_SLACK_MS older than LOG_KEEP_MS (about once a day),
//   so it holds the 7 days the token view needs and no more. A rewrite is a temp file `<account>.jsonl.<hex>.tmp` and a rename.
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendPlainFile, readPlainFileWith } from '../../../hooks/lib/plain-file.mjs';
import { withSessionLock } from '../../../hooks/lib/session-lock.mjs';
import {
  CREATE_FLAGS, FILE_MODE, isPrivateFile, isSessionId, lstatOrNull, privateFolder, readSessionFile, sameNode, TEMP_NAME_BYTES, writeSessionFile,
} from '../../../hooks/lib/session-store.mjs';

/** Samples kept per account: the pace needs two, twelve cover an hour of 5-minute changes. */
export const MAX_SAMPLES = 12;
/** The jsonl log keeps 7 days, the longest limit window. */
export const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How much older than LOG_KEEP_MS the first log line may get before the old lines go: one rewrite a day, not one per sample. */
const LOG_TRIM_SLACK_MS = 24 * 60 * 60 * 1000;
/** The limits file's byte cap for its writer and its reader: 12 samples of ~250 bytes (a 100-character session id) are 3 KB. */
const MAX_FILE_BYTES = 8192;
/** The log's byte cap for its writer and every reader: 7 days at one change per 5 minutes is about 2016 lines of ~170 bytes. */
export const MAX_LOG_BYTES = 1024 * 1024;
/** At the cap the oldest half of the log goes and writing goes on. */
const KEEP_LOG_BYTES = MAX_LOG_BYTES / 2;
/** Bytes read from the start of the log to date its first line; a sample line is about 170 bytes. */
const FIRST_LINE_BYTES = 1024;
/** The render tries the account lock once and never waits for another session's turn (see the header). */
const RENDER_LOCK_WAIT_MS = 0;
const LINE_BREAK = '\n';
const WINDOWS = ['five_hour', 'seven_day'];
const MAX_PERCENT = 100;
const AHEAD = 1;
const NO_NEWS = 0;
const BEHIND = -1;

/** @returns {string} the folder of the limits files */
export const limitsDir = () => join(homedir(), '.claude', 'state', 'limits');

/** @returns {boolean} true for a name usable as a file name (the account tool's names: letters, digits, `_` and `-`) */
export const isAccountName = (name) => isSessionId(name);

const isWindow = (value) => value === null || (typeof value === 'object' && Number.isFinite(value.used_percentage)
  && value.used_percentage >= 0 && value.used_percentage <= MAX_PERCENT && (value.resets_at === null || Number.isFinite(value.resets_at)));
const isSample = (value) => value !== null && typeof value === 'object' && Number.isFinite(value.t) && WINDOWS.every((name) => isWindow(value[name] ?? null));

/** One window of the status input as stored: { used_percentage, resets_at } or null (absent, or not a number). */
function windowOf(input) {
  if (!input || !Number.isFinite(input.used_percentage)) return null;
  return { used_percentage: input.used_percentage, resets_at: Number.isFinite(input.resets_at) ? input.resets_at : null };
}

/**
 * @param {string} account the account name (CLAUDE_ACCOUNT)
 * @param {{ dir?: string }} [deps] the limits folder (tests)
 * @returns {{ account: string, samples: object[] } | null} the file with its valid samples, oldest first; null when there is none or it is unusable
 */
export function readLimits(account, { dir = limitsDir() } = {}) {
  try {
    if (!isAccountName(account)) return null;
    const text = readSessionFile(dir, account, MAX_FILE_BYTES);
    if (typeof text !== 'string') return null;
    const file = JSON.parse(text);
    if (file?.account !== account || !Array.isArray(file.samples)) return null;
    return { account, samples: file.samples.filter(isSample).slice(-MAX_SAMPLES) };
  } catch {
    return null; // a half-written or foreign file reads as none: the next change writes it again
  }
}

/** @returns {object | null} the newest sample of a limits file */
export const latestSample = (file) => file?.samples.at(-1) ?? null;

/** @returns {{ five_hour: object | null, seven_day: object | null }} per window, its value in the newest stored sample that has it */
const newestWindows = (samples) => Object.fromEntries(WINDOWS.map((name) => [name, samples.findLast((s) => s[name])?.[name] ?? null]));

/** @returns {number} how one window of a new sample stands to the newest stored value of that window: AHEAD, NO_NEWS or BEHIND */
function windowStanding(next, newest) {
  if (next === null) return NO_NEWS; // a window the input lacks tells nothing, and the stored one is never filled from a guess
  if (newest === null) return AHEAD;
  if (next.resets_at !== null && newest.resets_at !== null && next.resets_at !== newest.resets_at) {
    return next.resets_at > newest.resets_at ? AHEAD : BEHIND; // a later window is news even at a lower percentage
  }
  if (next.used_percentage !== newest.used_percentage) return next.used_percentage > newest.used_percentage ? AHEAD : BEHIND;
  return next.resets_at !== null && newest.resets_at === null ? AHEAD : NO_NEWS; // the same use, now with its reset time
}

/**
 * @param {object} sample the new sample (at least one window)
 * @param {object[]} samples the stored samples, oldest first
 * @returns {boolean} true when the sample is ahead of the stored limits in some window and behind them in none, each window
 *   compared with the newest stored sample that has that window
 */
function isNews(sample, samples) {
  const newest = newestWindows(samples);
  const standings = WINDOWS.map((name) => windowStanding(sample[name], newest[name]));
  return standings.includes(AHEAD) && !standings.includes(BEHIND);
}

/** @returns {object | null} the sample the status input gives, with the writing session's id when it has a usable one */
function sampleOf(rateLimits, now, session) {
  const sample = { t: now, ...(isSessionId(session) ? { session } : {}), five_hour: windowOf(rateLimits.five_hour), seven_day: windowOf(rateLimits.seven_day) };
  return sample.five_hour === null && sample.seven_day === null ? null : sample;
}

/** @returns {string} up to length bytes of fd from position, as text */
function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  for (let got = -1; read < length && got !== 0; read += got) got = readSync(fd, buffer, read, length - read, position + read);
  return buffer.toString('utf8', 0, read);
}

/** Writes all of text to fd (a short write goes on from where it stopped). */
function writeAll(fd, text) {
  const buffer = Buffer.from(text);
  for (let written = 0; written < buffer.length;) written += writeSync(fd, buffer, written);
}

/** @returns {number} the sample time of a log line, NaN when the line is not one */
function lineTime(line) {
  try {
    const t = JSON.parse(line)?.t;
    return Number.isFinite(t) ? t : Number.NaN;
  } catch {
    return Number.NaN; // a torn or foreign line has no time
  }
}

/** @returns {boolean} true when the log must be rewritten before this line: the line would pass the cap, or the first line is old */
function needsRewrite(fd, size, lineBytes, now) {
  if (size + lineBytes > MAX_LOG_BYTES) return true;
  if (size === 0) return false;
  const first = readAt(fd, 0, Math.min(size, FIRST_LINE_BYTES)).split(LINE_BREAK, 1)[0];
  return !(lineTime(first) >= now - LOG_KEEP_MS - LOG_TRIM_SLACK_MS); // NaN (a foreign first line) rewrites too, which drops it
}

/** @returns {string} the log lines a rewrite keeps: whole samples of the last LOG_KEEP_MS, only the newest half when at the cap */
function keptLines(fd, size, lineBytes, now) {
  const from = size + lineBytes > MAX_LOG_BYTES ? size - KEEP_LOG_BYTES : 0;
  const lines = readAt(fd, from, size - from).split(LINE_BREAK);
  const whole = from > 0 ? lines.slice(1) : lines; // the first piece may start mid-line
  return whole.filter((line) => now - lineTime(line) <= LOG_KEEP_MS).map((line) => `${line}${LINE_BREAK}`).join('');
}

/** Replaces the log by text through a new temp file renamed over it while the folder is still the checked one. */
function rewriteLog(dir, path, text) {
  const folder = privateFolder(dir);
  if (folder === undefined) return false;
  const temp = `${path}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, CREATE_FLAGS, FILE_MODE);
    try {
      writeAll(fd, text);
    } finally {
      closeSync(fd);
    }
    if (!sameNode(lstatSync(dir), folder)) return false; // the folder was swapped meanwhile: store nothing
    renameSync(temp, path);
    return true;
  } finally {
    rmSync(temp, { force: true }); // after the rename nothing is left at that name
  }
}

/**
 * Reads what the next log line needs, through plain-file.mjs (no link followed, no FIFO waited on).
 * @returns {{ kept?: string, torn: boolean }} kept: the lines a rewrite keeps, when one is due (see needsRewrite); torn: the last
 *   line has no line break
 */
function logState(path, lineBytes, now) {
  return readPlainFileWith(path, (fd, size) => {
    if (needsRewrite(fd, size, lineBytes, now)) return { kept: keptLines(fd, size, lineBytes, now), torn: false };
    return { torn: size > 0 && readAt(fd, size - 1, 1) !== LINE_BREAK };
  });
}

/** Adds one line to the account's log (see the header); a link, a hard-linked or a foreign file is never written into. */
function appendLog(dir, account, sample) {
  const path = join(dir, `${account}.jsonl`);
  const existing = lstatOrNull(path);
  if (existing !== null && !isPrivateFile(existing)) return false; // also where O_NOFOLLOW does not exist (Windows)
  const line = `${JSON.stringify(sample)}${LINE_BREAK}`;
  const lineBytes = Buffer.byteLength(line) + LINE_BREAK.length; // room for the break a torn last line needs
  const state = existing === null ? { torn: false } : logState(path, lineBytes, sample.t);
  if (state.kept !== undefined) return rewriteLog(dir, path, state.kept + line);
  return appendPlainFile(path, state.torn ? `${LINE_BREAK}${line}` : line, { mode: FILE_MODE, maxBytes: MAX_LOG_BYTES });
}

/** Under the account's lock: stores the sample in the file and the log when it is still news against the stored limits. */
function storeSample(dir, account, sample) {
  const samples = readLimits(account, { dir })?.samples ?? [];
  if (!isNews(sample, samples)) return false; // another session stored the same or newer since the first look
  const text = JSON.stringify({ account, samples: [...samples, sample].slice(-MAX_SAMPLES) });
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return false; // readLimits would refuse it
  return writeSessionFile(dir, account, text, { sweep: false }) && appendLog(dir, account, sample);
}

/**
 * Stores a sample when the status input's limits are news against the newest stored one: the file (last MAX_SAMPLES) and one log line.
 * @param {string | undefined} account CLAUDE_ACCOUNT; without one nothing is written
 * @param {{ five_hour?: object, seven_day?: object } | undefined} rateLimits the status input's `rate_limits`
 * @param {{ dir?: string, now?: number, session?: string }} [deps] the folder and the clock (epoch ms; tests), and the writing
 *   session's id (the status input's `session_id`; stored only when it is a usable id)
 * @returns {boolean} true when a new sample was stored; false when it was no news, behind the newest, or could not be written
 */
export function recordSample(account, rateLimits, { dir = limitsDir(), now = Date.now(), session } = {}) {
  try {
    if (!isAccountName(account) || !rateLimits || typeof rateLimits !== 'object') return false;
    const sample = sampleOf(rateLimits, now, session);
    // A first look without the lock: most renders bring nothing new and need not touch it.
    if (sample === null || !isNews(sample, readLimits(account, { dir })?.samples ?? [])) return false;
    const stored = withSessionLock(dir, account, () => storeSample(dir, account, sample), { waitMs: RENDER_LOCK_WAIT_MS });
    return stored === true; // undefined: the lock was held (this sample is dropped) or the folder is unusable
  } catch {
    return false; // the status line must render even when the state folder is unusable
  }
}
