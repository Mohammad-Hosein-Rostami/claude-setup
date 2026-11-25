// Purpose: the install record, ~/.claude/.claude-setup-install.json: what this installer made, what it moved aside, and where
//   the links point. A second run reads it to change nothing; --uninstall reads it to undo exactly that and no more.
// Exports: RECORD_NAME, INSTALL_LOCK_NAME, INSTALL_LOCK_STALE_MS, recordPath, lockInstall, loadRecord, saveRecord, remember,
//   isMade, backup, ensureDir.
// Invariants: the record is written only when its content changes (a second identical run leaves it as it is); a file the
//   installer did not make is never removed, only moved into the backup folder (~/.claude-backup-<stamp>/) and named here;
//   one install at a time holds the lock from loading the record to saving it, so two runs never overwrite each other's entries.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { releaseLock, takeLock } from '../../home/tools/disk-free/lib/lock-file.mjs';
import { readRegularFile } from '../../home/tools/env-names/lib/read-regular-file.mjs';
import { InstallError, act, note, samePath } from './context.mjs';

export const RECORD_NAME = '.claude-setup-install.json';
const RECORD_VERSION = 1;

/** Where the record of this context's install lives. */
export const recordPath = (ctx) => join(ctx.claudeDir, RECORD_NAME);

export const INSTALL_LOCK_NAME = '.claude-setup-install.lock';
// An install takes seconds to a few minutes (plugins, npm installs). A lock with no pid in it older than this was left by a crash;
// a lock whose process still runs is held past it too, and then the refusal says the install may be hung.
export const INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;
const NEVER_BY_AGE = Infinity; // takeLock's limit that never breaks a lock for its age alone
const LOCK_TEXT_MAX_BYTES = 64; // a pid; a bigger file is not ours

/** True while process `pid` runs (EPERM: it runs as another user). */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Takes the lock over when its holder is dead (the pid in it names a process that has ended: a killed install, whatever the
 * lock's age) or the file names no valid pid and is older than INSTALL_LOCK_STALE_MS (an install writes its pid within
 * milliseconds, so an old pid-less file is a crash). A lock whose holder still runs is never taken, however old.
 * @returns {{taken: true} | {taken: false, pid: number|null, ageMs: number}} who still holds the lock when it was not taken
 */
function takeFromStaleOwner(lockPath, readLock) {
  let seen;
  try {
    seen = lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { taken: takeLock(lockPath, Date.now(), NEVER_BY_AGE) }; // released meanwhile
    throw error;
  }
  const held = { taken: false, pid: null, ageMs: Date.now() - seen.mtimeMs };
  if (!seen.isFile()) return held; // a FIFO or link is never read
  let text;
  try {
    text = readLock(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { taken: takeLock(lockPath, Date.now(), NEVER_BY_AGE) }; // released between the look and the read
    throw error;
  }
  const owner = Number(text);
  if (!Number.isInteger(owner) || owner <= 0) return { taken: takeLock(lockPath, Date.now(), INSTALL_LOCK_STALE_MS) }; // young: its owner is writing its pid now
  if (isRunning(owner)) return { ...held, pid: owner };
  // "Now" is the seen lock's own time and the limit 0, so only that lock counts as stale: a newer one taken meanwhile stays.
  return { taken: takeLock(lockPath, seen.mtimeMs, 0) };
}

/** Removes the lock while it still holds this process's pid; a successor's lock, a link, a FIFO or no lock stays. */
function releaseOwnLock(lockPath) {
  let read;
  try {
    read = readRegularFile(lockPath, LOCK_TEXT_MAX_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (read.bytes?.toString('utf8') === String(process.pid)) releaseLock(lockPath);
}

/** The refusal for a lock still held: names the holder's pid when known, and how to clear a holder that looks hung. */
function lockHeldMessage(lockPath, { pid, ageMs }) {
  if (pid == null) return `another install is running (${lockPath}); wait for it to end, or delete that file if no install runs`;
  const base = `another install is running (pid ${pid}, ${lockPath})`;
  if (ageMs < INSTALL_LOCK_STALE_MS) return `${base}; wait for it to end`;
  return `${base} and has held the lock for over 30 minutes; it may be hung: end process ${pid}, then run again (if ${pid} is not an install, delete ${lockPath} by hand)`;
}

/**
 * One install at a time: takes ~/.claude/.claude-setup-install.lock (O_EXCL; disk-free/lib/lock-file.mjs) and writes this
 * process's pid in it. Only a lock of a dead holder, or a pid-less one older than INSTALL_LOCK_STALE_MS, is taken over; a holder
 * that runs keeps it for as long as it runs.
 * @param {object} ctx the run context (~/.claude must exist)
 * @param {typeof readFileSync} [readLock] how the lock's text is read (tests give one that fails the way a release in between does)
 * @returns {() => void} releases the lock, only while the lock is still this process's
 * @throws {InstallError} when another install holds the lock, or ~/.claude is gone (an --uninstall removed it)
 */
export function lockInstall(ctx, readLock = readFileSync) {
  const lockPath = join(ctx.claudeDir, INSTALL_LOCK_NAME);
  try {
    // The first take never breaks by age: whether the holder runs is only known after reading its pid.
    if (!takeLock(lockPath, Date.now(), NEVER_BY_AGE)) {
      const outcome = takeFromStaleOwner(lockPath, readLock);
      if (!outcome.taken) throw new InstallError(lockHeldMessage(lockPath, outcome));
    }
    writeFileSync(lockPath, String(process.pid));
  } catch (error) {
    if (error.code === 'ENOENT' && !existsSync(ctx.claudeDir)) {
      throw new InstallError(`${ctx.claudeDir} was removed while this install started (an --uninstall is finishing); run again`);
    }
    throw error;
  }
  return () => releaseOwnLock(lockPath);
}

/**
 * The record of an earlier run, or a fresh one (`fresh: true`, never saved with that key).
 * @param {object} ctx the run context
 * @returns {{version: number, fresh: boolean, repo: string, root: string, tag: string|null, firstLayer: string|null, made: object[], backups: object[]}}
 * @throws {InstallError} when the file is not a record this installer wrote
 */
export function loadRecord(ctx) {
  const path = recordPath(ctx);
  if (!existsSync(path)) return { version: RECORD_VERSION, fresh: true, repo: ctx.repo, root: ctx.repo, tag: null, firstLayer: null, made: [], backups: [] };
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new InstallError(`${path} is not valid JSON (${error.message}); move it away and run again`);
  }
  if (record?.version !== RECORD_VERSION || !Array.isArray(record.made) || !Array.isArray(record.backups)) {
    throw new InstallError(`${path} is not an install record this installer knows; move it away and run again`);
  }
  return { ...record, fresh: false };
}

/** Writes the record when it changed; nothing under --dry-run. */
export function saveRecord(ctx, record) {
  if (ctx.dryRun || !existsSync(ctx.claudeDir)) return;
  const { fresh, ...kept } = record;
  const text = `${JSON.stringify(kept, null, 2)}\n`;
  const path = recordPath(ctx);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeFileSync(path, text);
}

/**
 * Adds one made thing ({kind, path, ...}) to the record once; a later entry for the same kind and path replaces it. A `line` is
 * also keyed by its text: one file can hold several of the installer's lines (the claude-as line and the rm-waiver block, whose
 * `line` holds its two lines joined by "\n").
 */
export function remember(record, entry) {
  const sameLine = (made) => entry.kind !== 'line' || made.line === entry.line;
  const index = record.made.findIndex((made) => made.kind === entry.kind && samePath(made.path, entry.path) && sameLine(made));
  if (index === -1) record.made.push(entry);
  else record.made[index] = { ...record.made[index], ...entry };
}

/** The record's entry for `path` (any kind but a line or a folder), or undefined. */
export function isMade(record, path) {
  return record.made.find((made) => !['line', 'dir'].includes(made.kind) && samePath(made.path, path));
}

/** `path`, or `path.1`, `path.2`, ... when taken: two runs in one second share a backup folder, and a backup never overwrites one. */
function freePath(path) {
  let candidate = path;
  for (let count = 1; existsSync(candidate); count += 1) candidate = `${path}.${count}`;
  return candidate;
}

/**
 * Moves `target` into the backup folder and records it, so --uninstall can put it back. A target the installer made itself
 * (its own earlier output) is recorded as `ours`: --uninstall deletes that copy instead of restoring it.
 * @param {object} ctx the run context
 * @param {object} record the install record
 * @param {string} target the file or folder to move aside
 * @returns {string} where it went
 */
export function backup(ctx, record, target) {
  const inHome = relative(ctx.home, target);
  const name = inHome.startsWith('..') || isAbsolute(inHome) ? join('outside-home', basename(target)) : inHome;
  const saved = freePath(join(ctx.backupDir, name));
  const ours = Boolean(isMade(record, target));
  act(ctx, `move ${target} to ${saved}`, () => {
    mkdirSync(dirname(saved), { recursive: true });
    renameSync(target, saved);
    record.backups.push({ path: target, backup: saved, backupRoot: ctx.backupDir, ours });
    note(ctx, `backed up ${basename(target)} -> ${ctx.backupDir}`);
  });
  return saved;
}

/** Makes a folder and each missing parent, recording each one it made (--uninstall removes them when empty). */
export function ensureDir(ctx, record, dir) {
  if (existsSync(dir)) return;
  ensureDir(ctx, record, dirname(dir));
  act(ctx, `make folder ${dir}`, () => {
    mkdirSync(dir);
    remember(record, { kind: 'dir', path: dir });
  });
}
