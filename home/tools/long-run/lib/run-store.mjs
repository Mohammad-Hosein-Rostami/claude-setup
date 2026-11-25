// Purpose: where a long run keeps its state (spec 7.6) and the small file primitives on it: paths, atomic JSON, the driver lock
//   and its heartbeat, per-run events, step journals, folder locks (one live run per folder) and the run list.
// Exports: RunBusy, STALE_BEAT_MS, RUN_ID_PATTERN, stateRoot, runPaths, newRunId, readJson, writeJson, appendJsonLine,
//   readJsonLines, readRunJob, readJournal, writeJournal, isPidAlive, driverAlive, acquireLock, releaseLock, runAccount, claimFolder,
//   releaseFolder, listRunIds, ensureRunDirs.
// Invariants: folders 0700 and files 0600 (account/lib/private-fs.mjs); every JSON file is replaced whole (temp + rename), so a
//   reader never sees half of one; one holder rule (lockHolder) decides for every caller whether a run is held; the lock line
//   `<pid> <host> <start>` is created whole with flag "wx" and, when nobody holds the run, broken by one breaker at a time
//   (disk-free's breakStale) before it is created again; a release removes the lock only while it names this process; the lock
//   file is read without following a link or waiting on a FIFO, at most 256 bytes. Nothing here holds a token.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE, ensurePrivateDir, writeFileAtomic } from '../../account/lib/private-fs.mjs';
import { breakStale } from '../../disk-free/lib/lock-file.mjs';
import { processStarts } from '../../disk-free/lib/live-sessions.mjs';
import { folderKey, readFrozenJob } from './job.mjs';

/** A driver whose heartbeat is older than this is gone (it beats every 30 s). */
export const STALE_BEAT_MS = 120 * 1000;
/** A run id: `<job name>-<yyyymmdd-hhmmss>` in local time, `-<n>` added when two start in one second. */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}-\d{8}-\d{6}(?:-\d{1,3})?$/;
const JOURNAL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAD_TWO = 2;
const MAX_SAME_SECOND = 999;

/** A run whose driver lives (exit code 4 in the CLI). */
export class RunBusy extends Error {}

/** `LONG_RUN_STATE_DIR` (tests), else `~/.claude/state/long-run` (the real state folder, never through the tools link). */
export const stateRoot = (env = process.env) => env.LONG_RUN_STATE_DIR || join(env.HOME || homedir(), '.claude', 'state', 'long-run');

/**
 * Every path of one run.
 * @param {string} root stateRoot().
 * @param {string} runId a run id (checked against RUN_ID_PATTERN).
 * @returns {Record<string, string>}
 * @throws {Error} for a run id that does not match.
 */
export function runPaths(root, runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`not a run id: ${String(runId).slice(0, 60)}`);
  const dir = join(root, runId);
  return {
    root, runId, dir, job: join(dir, 'job.json'), run: join(dir, 'run.json'), checkpoints: join(dir, 'checkpoints.sqlite'),
    driver: join(dir, 'driver.json'), lock: join(dir, 'driver.lock'), control: join(dir, 'control'), steps: join(dir, 'steps'),
    logs: join(dir, 'logs'), events: join(dir, 'events.jsonl'), summary: join(dir, 'summary.md'), driverLog: join(dir, 'driver.log'),
    rerun: join(dir, 'rerun.json'),
  };
}

/** Makes the run folder and its sub-folders, 0700. */
export function ensureRunDirs(paths) {
  for (const dir of [paths.root, paths.dir, paths.control, paths.steps, paths.logs]) ensurePrivateDir(dir);
}

const two = (value) => String(value).padStart(PAD_TWO, '0');
const stamp = (now) => `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;

/** A new run id for job `name` at local time `now` that no folder under `root` uses yet. */
export function newRunId(root, name, now) {
  const base = `${name}-${stamp(now)}`;
  for (let n = 1; n <= MAX_SAME_SECOND; n += 1) {
    const runId = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(root, runId))) return runId;
  }
  throw new Error(`too many runs of ${name} in one second`);
}

/** The parsed JSON of `path`, or null when it does not exist. @throws on unreadable or invalid JSON. */
export function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/** Replaces `path` with `value` as JSON (0600, temp file and rename). */
export const writeJson = (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

/** Appends one JSON line (0600 on create). */
export const appendJsonLine = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE });

/** The JSON lines of a file; a torn or foreign line is skipped. */
export function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // a line torn by a killed writer: the rest of the file is still read (P16)
    }
  });
}

const journalPath = (paths, unitId) => {
  if (!JOURNAL_ID.test(unitId)) throw new Error(`not a step id: ${String(unitId).slice(0, 60)}`);
  return join(paths.steps, `${unitId}.json`);
};

/** The run's frozen job (job.json), normalized. @throws {JobError} for another runner version. */
export const readRunJob = (paths) => readFrozenJob(readFileSync(paths.job, 'utf8'));

/** The journal of a step or item, or null before its first start. */
export const readJournal = (paths, unitId) => readJson(journalPath(paths, unitId));

/** Replaces the journal of a step or item. */
export const writeJournal = (paths, unitId, journal) => writeJson(journalPath(paths, unitId), journal);

/** Whether a process with this pid runs on this machine (EPERM: it runs as another user). */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const MS_PER_SECOND = 1000;
// ps lstart has whole seconds, and Linux derives it from boot time and clock ticks, so one process can read a second apart.
const START_TOLERANCE_MS = 2000;
const LOCK_READ_MAX_BYTES = 256; // a lock line is about 50 bytes; a bigger file is not a lock
// `<pid> <host> <start epoch ms>`; main's drivers wrote `<pid> <host>` (no start).
const LOCK_PATTERN = /^(\d+) (\S+)(?: (\d+))?\n?$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // not defined on Windows
const NO_BLOCK = constants.O_NONBLOCK ?? 0;

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The text of the regular file at `path` (at most LOCK_READ_MAX_BYTES), never following a link or waiting on a FIFO; null when gone. */
function readSmallFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(LOCK_READ_MAX_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The lock file as data: null when there is none; `{ kind: 'other' }` for a link, FIFO, folder or text that is no lock;
 * `{ kind: 'empty', mtimeMs }` while a taker is writing it; `{ kind: 'lock', pid, host, startMs }` (startMs null in main's form).
 */
function readLock(lockPath) {
  const info = lstatOrNull(lockPath);
  if (info === null) return null;
  if (!info.isFile()) return { kind: 'other' };
  if (info.size === 0) return { kind: 'empty', mtimeMs: info.mtimeMs };
  const text = readSmallFile(lockPath);
  if (text === null) return null;
  const match = LOCK_PATTERN.exec(text);
  if (match === null) return { kind: 'other' };
  return { kind: 'lock', pid: Number(match[1]), host: match[2], startMs: match[3] === undefined ? null : Number(match[3]) };
}

/**
 * Who holds the run (the one holder rule, for resume, the driver, pause, status and prune), or null when nobody does:
 * (a) driver.json names a live pid on this host with a beat younger than STALE_BEAT_MS by the caller's `now` (main's rule);
 * an empty lock younger than STALE_BEAT_MS (a taker is writing it); or the lock names a live pid on this host and (b) ps shows
 * that pid started at the lock's start (the taker, however old its beat: starting, after a sleep), or (c) ps cannot tell and
 * that start is under STALE_BEAT_MS ago (a starting taker). Anything else (a pid ps proves reused, main's lock without a start
 * or an old start where ps cannot tell) leaves the beat rule alone to decide, so main's rule is the floor. (b), (c) and the
 * empty-lock age use the real clock.
 * @returns {{pid: number | null, how: 'driver' | 'lock' | 'writing'} | null}
 */
function lockHolder(paths, now) {
  const lock = readLock(paths.lock);
  if (lock === null) return null;
  const driver = readJson(paths.driver);
  const beatFresh = driver !== null && now.getTime() - Date.parse(driver.beatAt) < STALE_BEAT_MS;
  if (beatFresh && driver.host === hostname() && isPidAlive(driver.pid)) return { pid: driver.pid, how: 'driver' };
  const realNow = Date.now();
  if (lock.kind === 'empty') return realNow - lock.mtimeMs < STALE_BEAT_MS ? { pid: null, how: 'writing' } : null;
  if (lock.kind !== 'lock' || lock.startMs === null || lock.host !== hostname() || !isPidAlive(lock.pid)) return null;
  const psStart = processStarts([lock.pid]).get(lock.pid);
  const isTaker = psStart === undefined ? realNow - lock.startMs < STALE_BEAT_MS : Math.abs(psStart - lock.startMs) <= START_TOLERANCE_MS;
  return isTaker ? { pid: lock.pid, how: 'lock' } : null;
}

/** Whether a live driver holds the run (lockHolder's rule); `paths` is runPaths(), `now` the time the beat is judged by. */
export function driverAlive(paths, now = new Date()) {
  return lockHolder(paths, now) !== null;
}

/** The lock line of this process; its start is ps's own view where ps runs, so (b) compares like with like. */
function lockText() {
  const startMs = processStarts([process.pid]).get(process.pid) ?? Math.round(Date.now() - process.uptime() * MS_PER_SECOND);
  return `${process.pid} ${hostname()} ${startMs}\n`;
}

/** Creates the lock with flag "wx" (never through a link); false when a file is already there. */
function createLock(lockPath, text) {
  try {
    writeFileSync(lockPath, text, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

const BUSY_HOW = { driver: (pid) => `its driver runs (pid ${pid})`, lock: (pid) => `pid ${pid} holds its lock`, writing: () => 'another driver is taking its lock' };

/**
 * Takes the run's driver lock. A lock nobody holds (lockHolder) is broken by one breaker at a time (disk-free's breakStale),
 * then created again; losing any step is RunBusy.
 * @param {Record<string, string>} paths runPaths().
 * @param {Date} now the current time (for the beat).
 * @throws {RunBusy} when the run is held, or another driver takes the lock first.
 */
export function acquireLock(paths, now = new Date()) {
  const text = lockText();
  const tookJustNow = () => new RunBusy(`run ${paths.runId} is busy: another driver took it just now`);
  if (createLock(paths.lock, text)) return;
  const seen = lstatOrNull(paths.lock);
  if (seen === null && createLock(paths.lock, text)) return; // released between the two calls
  if (seen === null) throw tookJustNow();
  const holder = lockHolder(paths, now);
  if (holder !== null) throw new RunBusy(`run ${paths.runId} is busy: ${BUSY_HOW[holder.how](holder.pid)}`);
  if (!breakStale(paths.lock, seen, Date.now(), STALE_BEAT_MS)) throw new RunBusy(`run ${paths.runId} is busy: ${BUSY_HOW.writing()}`);
  if (!createLock(paths.lock, text)) throw tookJustNow();
}

/** Removes the lock while it still names this process. */
export function releaseLock(paths) {
  const lock = readLock(paths.lock);
  if (lock?.kind === 'lock' && lock.pid === process.pid) rmSync(paths.lock, { force: true });
}

/**
 * The account run.json names now (`start` and `resume --account` write it), for a driver that follows a switch.
 * @returns {string | null} null on any read or parse error ("no change"): timers read it, and a timer must never throw.
 */
export function runAccount(paths) {
  try {
    const account = readJson(paths.run)?.account;
    return typeof account === 'string' ? account : null;
  } catch {
    return null; // a run.json being replaced or damaged: the next read tells
  }
}

const folderLockPath = (root, folder) => join(root, 'cwd-locks', createHash('sha256').update(folderKey(folder)).digest('hex'));

/**
 * Records that run `runId` uses `folder`; one live run per folder (two bosses committing in one checkout).
 * @param {string} root stateRoot().
 * @param {string} runId the run.
 * @param {string} folder the folder (realpath is taken).
 * @param {(otherRunId: string) => boolean} isLive whether another run that holds the folder still counts as live.
 * @throws {RunBusy} naming the live run that uses it.
 */
export function claimFolder(root, runId, folder, isLive) {
  ensurePrivateDir(join(root, 'cwd-locks'));
  const path = folderLockPath(root, folder);
  const holder = existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  if (holder && holder !== runId && RUN_ID_PATTERN.test(holder) && isLive(holder)) {
    throw new RunBusy(`folder ${folder} is used by live run ${holder}; stop or finish it first (two bosses would commit in one checkout)`);
  }
  writeFileAtomic(path, `${runId}\n`);
}

/** Frees `folder` when `runId` holds it. */
export function releaseFolder(root, runId, folder) {
  if (!existsSync(folder)) return; // its lock names a run that is no longer live, so it blocks nobody (claimFolder's isLive)
  const path = folderLockPath(root, folder);
  if (existsSync(path) && readFileSync(path, 'utf8').trim() === runId) rmSync(path, { force: true });
}

/** The run ids under `root`, newest first (by the stamp in the id). */
export function listRunIds(root) {
  if (!existsSync(root)) return [];
  const stampOf = (runId) => runId.match(/(\d{8}-\d{6})(?:-\d+)?$/)[1];
  return readdirSync(root).filter((name) => RUN_ID_PATTERN.test(name) && existsSync(join(root, name, 'job.json')))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a));
}
