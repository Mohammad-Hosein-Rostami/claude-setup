// Purpose: the landing log `<git common dir>/cs-tidy-log.jsonl`. `land` reads a lane's history before it moves the lane and
//   records it once the lane has landed, since deleting the branch deletes its reflog, the only record of what was folded into
//   it. `prune` reads the landings (folded.mjs proves folded branches from them) and records each branch it deletes, with its
//   sha, so it can be restored (`git branch <name> <sha>`) while git still keeps the commit (`gc.pruneExpire`, 2 weeks by default).
// Exports: readLaneHistory, recordLanding, readLandings, recordDeletion, LOG_FILE.
// Invariants: one JSON object per line, appended (`{"landed": {...}}` or `{"deleted": {...}}`); a record is started on a new
//   line when the file does not end with one (a torn write), so a torn line never swallows the next record. Each line is
//   parsed on its own: one that does not parse or does not match the shape is skipped, never taken as proof. Records older than MAX_AGE_DAYS are not read; once the file
//   passes MAX_LOG_BYTES it is rewritten without them (a temporary file, then a rename). A missing log means no landings.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchIdsOfCommits } from './copies.mjs';
import { MAX_REFLOG_ENTRIES, changeIdsOfCommits, commitsOutside, provenHistoryShas } from './folded.mjs';
import { gitText, runGit } from './git.mjs';

export const LOG_FILE = 'cs-tidy-log.jsonl';
const MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
// Over this many commits in a lane's history its patch and change ids are not read: ancestry alone proves a fold then.
const MAX_LINE_COMMITS = 500;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // a full SHA-1 or SHA-256 object name
const MS_PER_SECOND = 1000;
const NEWLINE = 0x0a;

// The log's path per folder, read once: prune records each deletion, and one git call per deleted branch would add up.
const logPaths = new Map();
function logPath(dir) {
  if (!logPaths.has(dir)) logPaths.set(dir, join(gitText(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']), LOG_FILE));
  return logPaths.get(dir);
}

/**
 * The history of `branch`, read before land moves it: `{ branch, tip, shas, patchIds, changeIds, lastCommitMs }`. `shas` are
 * its tip and the reflog positions that prove a fold (folded.mjs provenHistoryShas: down to its newest reset, and not past a
 * step that may have dropped a commit); `patchIds` and `changeIds` (folded.mjs changeIdsOfCommits) are those of the commits
 * they reach that `baseSha` lacks (both null over MAX_LINE_COMMITS); `lastCommitMs` is the committer date of its tip. A branch
 * with no reflog has its tip alone. Throws when git cannot read the branch.
 */
export function readLaneHistory(dir, branch, baseSha) {
  const ref = `refs/heads/${branch}`;
  const tip = gitText(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const reflog = runGit(dir, ['reflog', 'show', '--format=%H%x00%gs', '-n', String(MAX_REFLOG_ENTRIES), ref]);
  const entries = reflog.status !== 0 ? [] : reflog.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, subject] = line.split('\0');
    return { hash, subject };
  });
  const shas = provenHistoryShas(dir, tip, entries);
  const line = commitsOutside(dir, shas, [baseSha]);
  if (line === null) throw new Error(`git cannot walk the history of ${branch}`);
  const hashes = line.map(({ hash }) => hash);
  const isLong = line.length > MAX_LINE_COMMITS;
  const [patchIds, changeIds] = isLong ? [null, null] : [patchIdsOfCommits(dir, hashes), changeIdsOfCommits(dir, hashes)];
  const lastCommitMs = Number(gitText(dir, ['log', '-1', '--format=%ct', tip])) * MS_PER_SECOND;
  return { branch, tip, shas, patchIds, changeIds, lastCommitMs };
}

// True when the file at `path` is missing, empty or ends with a newline, so the next record starts a line of its own.
function endsWithNewline(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === NEWLINE;
  } finally {
    closeSync(fd);
  }
}

// Appends one record on a line of its own, then trims the file once it is too big.
function appendRecord(dir, record, now) {
  const path = logPath(dir);
  const start = endsWithNewline(path) ? '' : '\n';
  appendFileSync(path, `${start}${JSON.stringify(record)}\n`, { flag: 'a' });
  if (statSync(path).size <= MAX_LOG_BYTES) return;
  const fresh = readFileSync(path, 'utf8').split('\n').filter((line) => {
    const parsed = parseRecord(line);
    return parsed !== null && now - parsed.at <= MAX_AGE_DAYS * MS_PER_DAY;
  });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, fresh.map((line) => `${line}\n`).join(''));
  renameSync(temporary, path);
}

/** Records that `history` (readLaneHistory) landed on `base` as `landedTip`, at `at` (ms). Throws when the log cannot be written. */
export function recordLanding(dir, history, { base, landedTip, at = Date.now() }) {
  appendRecord(dir, { landed: { ...history, base, landedTip, landedAt: at } }, at);
}

/** Records that `branch` was deleted at `sha` and why, so it can be restored. Throws when the log cannot be written. */
export function recordDeletion(dir, { branch, sha, reason, at = Date.now() }) {
  appendRecord(dir, { deleted: { branch, sha, reason, at } }, at);
}

const isHash = (value) => typeof value === 'string' && HASH.test(value);
// A list of hashes, or null (not read: ancestry only); missing counts as null.
const isHashList = (value) => value === undefined || value === null || (Array.isArray(value) && value.every(isHash));
const isTime = (value) => Number.isFinite(value);
const isName = (value) => typeof value === 'string' && value !== '';

// The shape check of a `landed` record: anything else is not a landing.
const isLanding = (entry) => entry !== null && typeof entry === 'object' && isName(entry.branch) && isName(entry.base)
  && isHash(entry.tip) && isHash(entry.landedTip) && Array.isArray(entry.shas) && entry.shas.length > 0 && entry.shas.every(isHash)
  && entry.patchIds !== undefined && isHashList(entry.patchIds) && isHashList(entry.changeIds)
  && isTime(entry.lastCommitMs) && isTime(entry.landedAt);

const isDeletion = (entry) => entry !== null && typeof entry === 'object' && isName(entry.branch) && isHash(entry.sha) && isTime(entry.at);

/** One log line as `{ landing }` or `{ deletion }` with its time `at`, or null when it is not a record of either shape. */
function parseRecord(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // an unreadable line (a torn write, a hand edit) is no record
  }
  if (isLanding(parsed?.landed)) return { landing: parsed.landed, at: parsed.landed.landedAt };
  if (isDeletion(parsed?.deleted)) return { deletion: parsed.deleted, at: parsed.deleted.at };
  return null;
}

/**
 * The landings of the last MAX_AGE_DAYS, newest first; [] when there is no log. Throws, naming the log, when an existing log
 * cannot be read (a folder in its place, no permission).
 */
export function readLandings(dir, now = Date.now()) {
  const path = logPath(dir);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`the landing log ${path} cannot be read: ${error.message}`, { cause: error });
  }
  return text.split('\n').map(parseRecord)
    .filter((record) => record?.landing && now - record.at <= MAX_AGE_DAYS * MS_PER_DAY)
    .map(({ landing }) => landing)
    .sort((a, b) => b.landedAt - a.landedAt);
}
