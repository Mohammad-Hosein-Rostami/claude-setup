// Purpose: the sync record (plan-core-best, cb-sync-2). scripts/sync-machines.mjs writes the result of every run that reached
//   verify, so the boss's tick can show a machine that is behind or a sync that keeps failing, instead of the failure scrolling
//   away in a background log. Also sync's repo-path check and its run lock, so sync and the tick share one definition of each.
// Exports: isSyncablePath(path), syncLockPath(env), syncRunning(env), syncRecordPath(repoDir, env), readSyncRecord(repoDir, env),
//   writeSyncRecord(repoDir, record, env), nextSyncRecord(previous, run).
// File: <HOME>/.claude/state/sync/<repo-key>.json, <repo-key> the land ledger's (land/ledger.mjs repoKey), so every worktree of
//   one repository shares one record. Record:
//   { at, repo, sha, ok, problem, failures, failedSince, machines: [{ machine, sha, ok, at, problem }] }
//   - at: the ISO time of the last run; repo: its --repo folder; sha: the base tip it synced to ('' when it stopped before
//     reading the tip: verify or a crash); problem: why the run itself stopped before any machine ('' when it did not).
//   - ok: every configured machine is at that base tip, synced there by a base run (a `--tag` run never counts).
//   - failures: the failed runs in a row (a run fails on a problem or a machine it did not sync), 0 after a run that failed
//     nothing; failedSince: the time of the first of them ('' when failures is 0).
//   - machines: one entry per configured machine, this machine first. sha: the base tip a base run last synced it to ('' when
//     none); ok: its last run synced it there by a base run; at: the time of that run ('' when none); problem: why not ok.
//     A run updates only the machines it ran (`--targets` runs a subset); an entry of a machine no longer configured is dropped.
// Invariants: only sync writes the record, under its run lock, so there is one writer at a time; the write is a temp file and a
//   rename (hooks/lib/session-store.mjs, 0600, no link followed, never swept), so a reader sees the old or the new record, never
//   half of one. Writer and reader share MAX_RECORD_BYTES. A record that cannot be read is `{ unreadable }`, never a crash.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { repoKey } from '../../land/ledger.mjs';
import { isPidAlive } from '../../long-run/lib/run-store.mjs';

// Absolute or ~/..., no space, quote, $, backtick or backslash: the path reaches sync's ssh and scp lines unquoted.
const SYNCABLE_PATH = /^(\/|~\/)[A-Za-z0-9._/+@:~-]*$/;
const RUN_LOCK_NAME = 'sync-machines.lock';
const MAX_LOCK_BYTES = 32; // the lock holds one pid
const MAX_RECORD_BYTES = 64 * 1024; // a record of some 15 machines with problems at their cap
const MAX_PROBLEM_CHARS = 1000; // a problem is the tail of a command's output: a very long line is cut, so the record fits
const NO_RUN_YET = { sha: '', ok: false, at: '', problem: 'no sync recorded yet' };

/**
 * Whether sync accepts the path as its --repo (and as its temp folder): it reaches the ssh and scp lines without quotes.
 * @param {unknown} path the path
 * @returns {boolean} true for an absolute or ~/... path of letters, digits and . _ / + @ : ~ - only
 */
export const isSyncablePath = (path) => typeof path === 'string' && SYNCABLE_PATH.test(path);

/**
 * The run lock that keeps one sync at a time: <tmp>/sync-machines.lock, holding the running sync's pid.
 * @param {object} [env] the environment; its TMPDIR wins over the process's own (os.tmpdir reads only process.env)
 * @returns {string} the lock file's path
 */
export const syncLockPath = (env = process.env) => join(process.platform !== 'win32' && env.TMPDIR ? env.TMPDIR : tmpdir(), RUN_LOCK_NAME);

/**
 * Whether a sync runs now: its run lock names a live pid. A lock left by a killed sync is not a running sync.
 * @param {object} [env] the environment (TMPDIR)
 * @returns {boolean} true while the lock's pid runs
 * @throws {Error} the lock path holds a link, a folder or a FIFO, or cannot be read (sync refuses to run then too)
 */
export function syncRunning(env = process.env) {
  let holder;
  try {
    holder = readPlainFile(syncLockPath(env), MAX_LOCK_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return isPidAlive(Number(holder)); // '' (a sync writing its pid this moment) is 0: not running yet
}

const recordDir = (env) => join(env.HOME || homedir(), '.claude', 'state', 'sync');

/**
 * The sync record of the repository that holds `repoDir`: <HOME>/.claude/state/sync/<repo-key>.json.
 * @param {string} repoDir any folder of the repository
 * @param {object} [env] the environment (HOME)
 * @returns {string} the record's path
 * @throws {Error} git cannot name the repository (repoKey)
 */
export const syncRecordPath = (repoDir, env = process.env) => join(recordDir(env), `${repoKey(repoDir)}.json`);

const isText = (value) => typeof value === 'string';
const isFlag = (value) => typeof value === 'boolean';
const MACHINE_FIELDS = { machine: isText, sha: isText, ok: isFlag, at: isText, problem: isText };
const RECORD_FIELDS = {
  at: isText,
  repo: isText,
  sha: isText,
  ok: isFlag,
  problem: isText,
  failures: (value) => Number.isSafeInteger(value) && value >= 0,
  failedSince: isText,
  machines: (value) => Array.isArray(value) && value.every((entry) => hasFields(MACHINE_FIELDS, entry)),
};

function hasFields(fields, value) {
  return value !== null && typeof value === 'object' && Object.entries(fields).every(([name, check]) => check(value[name]));
}

/**
 * The last sync record of the repository that holds `repoDir`.
 * @param {string} repoDir any folder of the repository
 * @param {object} [env] the environment (HOME)
 * @returns {object | null | { unreadable: string }} the record (see the header); null before the first sync that reached
 *   verify; `{ unreadable }` with why when the file is a link, too big, torn or not a record
 * @throws {Error} git cannot name the repository (repoKey)
 */
export function readSyncRecord(repoDir, env = process.env) {
  const path = syncRecordPath(repoDir, env);
  const text = readSessionFile(recordDir(env), repoKey(repoDir), MAX_RECORD_BYTES);
  if (text === null) return null;
  if (text === undefined) return { unreadable: `${path} is not a plain file of yours, or over ${MAX_RECORD_BYTES} bytes` };
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { unreadable: `${path} is not JSON (${error.message})` };
  }
  return hasFields(RECORD_FIELDS, value) ? value : { unreadable: `${path} is not a sync record` };
}

/**
 * Replaces the sync record of the repository that holds `repoDir` (temp file and rename). Only sync calls it, under its run lock.
 * @param {string} repoDir any folder of the repository
 * @param {object} record the new record (nextSyncRecord's result)
 * @param {object} [env] the environment (HOME)
 * @throws {Error} the record is over MAX_RECORD_BYTES, its folder or file is not a plain one of yours, the write failed, or git
 *   cannot name the repository
 */
export function writeSyncRecord(repoDir, record, env = process.env) {
  const path = syncRecordPath(repoDir, env);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(`the sync record for ${path} is over ${MAX_RECORD_BYTES} bytes`);
  if (!writeSessionFile(recordDir(env), repoKey(repoDir), text, { sweep: false })) {
    throw new Error(`cannot write the sync record ${path}: its folder or file is not a plain one of yours, or the write failed`);
  }
}

const capped = (problem) => problem.slice(0, MAX_PROBLEM_CHARS);

/** A machine's entry after this run ran it: ok only when a base run synced it, else its last base sha stays with the problem. */
function machineEntry(old, row, { at, tag }) {
  if (!row.synced) return { machine: row.machine, sha: old.sha, ok: false, at, problem: capped(row.problem) };
  if (tag) return { machine: row.machine, sha: old.sha, ok: false, at, problem: `synced by a --tag ${tag} run, which never counts as the base: sync again without --tag` };
  return { machine: row.machine, sha: row.sha, ok: true, at, problem: '' };
}

/**
 * The record after a run, merged with the one before it (see the header for each field).
 * @param {object | null} previous the record before (readSyncRecord's), null when there is none or it was unreadable
 * @param {{ at: string, repo: string, sha: string, tag: string, configured: string[], rows: object[], problem: string }} run
 *   at: this run's ISO time; sha: the base tip it synced to ('' when it stopped before); tag: the --tag ('' for a base run);
 *   configured: every machine name, this machine first; rows: sync's rows ({ machine, synced, sha, problem }, none when it
 *   stopped before the machines); problem: why it stopped before the machines ('' when it did not)
 * @returns {object} the new record
 */
export function nextSyncRecord(previous, { at, repo, sha, tag, configured, rows, problem }) {
  const before = new Map((previous?.machines ?? []).map((entry) => [entry.machine, entry]));
  const ran = new Map(rows.map((row) => [row.machine, row]));
  const machines = configured.map((machine) => {
    const old = before.get(machine) ?? { machine, ...NO_RUN_YET };
    const row = ran.get(machine);
    return row ? machineEntry(old, row, { at, tag }) : old;
  });
  const isFailed = problem !== '' || rows.some((row) => !row.synced);
  const wasFailing = (previous?.failures ?? 0) > 0;
  return {
    at,
    repo,
    sha,
    ok: !isFailed && sha !== '' && machines.every((entry) => entry.ok && entry.sha === sha),
    problem: capped(problem),
    failures: isFailed ? (previous?.failures ?? 0) + 1 : 0,
    failedSince: isFailed ? (wasFailing ? previous.failedSince : at) : '',
    machines,
  };
}
