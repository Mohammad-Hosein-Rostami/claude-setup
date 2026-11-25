// Purpose: where a long run keeps its state (spec 7.6) and the small file primitives on it: paths, atomic JSON, the driver lock
//   and its heartbeat, per-run events, step journals, folder locks (one live run per folder) and the run list.
// Exports: RunBusy, STALE_BEAT_MS, RUN_ID_PATTERN, stateRoot, runPaths, newRunId, readJson, writeJson, appendJsonLine,
//   readJsonLines, readRunJob, readJournal, writeJournal, isPidAlive, driverAlive, acquireLock, releaseLock, claimFolder, releaseFolder,
//   listRunIds, ensureRunDirs.
// Invariants: folders 0700 and files 0600 (account/lib/private-fs.mjs); every JSON file is replaced whole (temp + rename), so a
//   reader never sees half of one; the lock file is created with flag "wx" and is broken only when its driver is gone (dead pid on
//   this host, or a heartbeat older than STALE_BEAT_MS: a reused pid is caught by the beat age), unless ps shows that the process
//   the lock names is the live process that took it, whatever the age of the lock or the beat (a starting driver has no beat
//   yet; a driver after a sleep has an old one); where ps cannot tell (Windows, a lock without a start) the beat rule alone
//   decides; a release removes the lock only while it still names this process. Nothing here holds a token.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE, ensurePrivateDir, writeFileAtomic } from '../../account/lib/private-fs.mjs';
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

/**
 * Whether the run's driver lives: its driver.json names a pid of this host that runs, with a beat younger than STALE_BEAT_MS.
 * @param {Record<string, string>} paths runPaths().
 * @param {Date} now the current time.
 * @returns {boolean}
 */
export function driverAlive(paths, now = new Date()) {
  const driver = readJson(paths.driver);
  if (!driver || !existsSync(paths.lock)) return false;
  const fresh = now.getTime() - Date.parse(driver.beatAt) < STALE_BEAT_MS;
  return fresh && driver.host === hostname() && isPidAlive(driver.pid);
}

const MS_PER_SECOND = 1000;
// ps lstart has whole seconds, and Linux derives it from boot time and clock ticks, so one process can read a second apart.
const START_TOLERANCE_MS = 2000;

/** The lock text: this process's pid, host and start (epoch ms), so a later reader can tell this process from a reused pid. */
const lockText = () => `${process.pid} ${hostname()} ${Math.round(Date.now() - process.uptime() * MS_PER_SECOND)}\n`;

/**
 * The pid of the live process on this host that took the lock, when ps shows its start matches the one the lock records; else
 * null. driverAlive misses a live driver that has not written its first beat yet, or whose beat is old after a sleep; breaking
 * its lock would leave it running beside a second driver. Where the start cannot be compared (Windows, a lock without a
 * start), null leaves the choice to driverAlive's beat rule, so a crashed run whose pid was reused can still be taken over.
 */
function liveLockHolder(lockPath) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null; // released just now: nothing to protect
    throw error;
  }
  const [pidText, host, startText] = text.trim().split(' ');
  const pid = Number(pidText);
  if (host !== hostname() || !isPidAlive(pid)) return null;
  if (startText === undefined) return null;
  const startMs = processStarts([pid]).get(pid);
  const isTaker = startMs !== undefined && Math.abs(startMs - Number(startText)) <= START_TOLERANCE_MS;
  return isTaker ? pid : null;
}

/**
 * Takes the run's driver lock.
 * @param {Record<string, string>} paths runPaths().
 * @param {Date} now the current time.
 * @throws {RunBusy} when a live driver holds it, or ps shows the process that took it still runs on this host (liveLockHolder).
 */
export function acquireLock(paths, now = new Date()) {
  const text = lockText();
  try {
    writeFileSync(paths.lock, text, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (driverAlive(paths, now)) throw new RunBusy(`run ${paths.runId} is busy: its driver runs (pid ${readJson(paths.driver)?.pid})`);
  const holder = liveLockHolder(paths.lock);
  if (holder !== null) throw new RunBusy(`run ${paths.runId} is busy: pid ${holder} holds its lock`);
  rmSync(paths.lock, { force: true });
  try {
    writeFileSync(paths.lock, text, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  } catch (error) {
    if (error.code === 'EEXIST') throw new RunBusy(`run ${paths.runId} is busy: another driver took it just now`);
    throw error;
  }
}

/** Removes the lock while it still names this process. */
export function releaseLock(paths) {
  if (!existsSync(paths.lock)) return;
  if (readFileSync(paths.lock, 'utf8').split(' ')[0] === String(process.pid)) rmSync(paths.lock, { force: true });
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
