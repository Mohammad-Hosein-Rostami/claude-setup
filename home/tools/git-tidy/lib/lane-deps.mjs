// Purpose: the deps cache of a repository, so a lane whose lockfile was installed before gets its node_modules as a clone (APFS clone or
//   Linux reflink, through lane-fill.mjs cloneTree) instead of a second install. One cache per repository, shared by all its worktrees.
// Exports: depsKey, cloneFromCache, saveToCache, pruneCache.
// Invariants:
// - An entry is `<git common dir>/cs-lane-deps/<key>/node_modules`. The key is a sha256 of the lockfile's folder, name and sha256, the
//   Node ABI, the platform and the CPU type: one plain folder name that never holds `.tmp-`.
// - An entry is written once and never changed: saveToCache clones into `<key>.tmp-<pid>-<random>`, then renames it to `<key>`; when
//   `<key>` is already there the temp is deleted (both copies are equal). So a `<key>` folder is always whole.
// - A reader first writes `<key>/readers/<pid>`, then clones the entry into a temp of its own, keeps the clone only when that file is still
//   there afterwards, and renames it to `<folder>/node_modules`, so a lane never holds a half clone that already holds the marker; it
//   removes the reader file when done. An entry's last use is the mtime of its readers folder (adding or removing a reader file sets it).
// - pruneCache removes temps older than TEMP_MAX_AGE_MS and entries unused for UNUSED_MAX_AGE_MS with no live reader. A removal first
//   renames the folder to a fresh temp name, then deletes it: a reader whose entry goes mid-clone finds its reader file gone and drops the
//   clone, a save whose temp goes cannot rename it, and a crash mid-delete leaves only a temp that the next prune removes.
// - Writes only under `<git common dir>/cs-lane-deps` and to `<folder>/node_modules`; a node_modules that is a link is never saved.
//   Deleting the whole cache folder is always safe: the next claim installs again.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cloneTree } from './lane-fill.mjs';

const CACHE_FOLDER = 'cs-lane-deps';
const DEPENDENCY_FOLDER = 'node_modules';
const READERS_FOLDER = 'readers';
const TEMP_INFIX = '.tmp-';
const TEMP_RANDOM_BYTES = 4;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000; // a save or a read clones in seconds: an older temp was left by a crash
const UNUSED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const READER_PID = /^[1-9]\d{0,9}$/;

const isThere = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const removeTree = (path) => rmSync(path, { recursive: true, force: true });
const tempPathOf = (path) => `${path}${TEMP_INFIX}${process.pid}-${randomBytes(TEMP_RANDOM_BYTES).toString('hex')}`;

/** Milliseconds since the path last changed; 0 when it is gone (another prune took it). */
const ageMs = (path, nowMs) => nowMs - (lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? nowMs);

/** The names in a folder; none when it is gone (no cache yet, or another prune took it). */
function namesIn(folder) {
  try {
    return readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** True unless signal 0 says the process is gone (EPERM: it runs under another user). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const isLiveReader = (name) => READER_PID.test(name) && pidAlive(Number(name));

/**
 * The cache key of one lockfile folder's node_modules.
 * Why: a node_modules is right only for the same lockfile, and its native addons only for the same Node ABI, platform and CPU type.
 * @param {{ dir: string, lockfile: string, sha256: string }} install the lockfile's repo-relative folder (`.` for the root), its name
 *   and its sha256
 * @returns {string} 64 hex characters, safe as one folder name
 */
export function depsKey({ dir, lockfile, sha256 }) {
  const parts = [dir, lockfile, sha256, process.versions.modules, process.platform, process.arch];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Writes this process's reader file; false when the entry is not there. */
function writeReader(reader) {
  try {
    writeFileSync(reader, '');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Replaces the lane's node_modules with the finished clone in one rename, so a kill never leaves a half clone holding the marker. */
function moveIntoLane(clone, target) {
  removeTree(target);
  try {
    renameSync(clone, target);
    return 'cloned';
  } catch (error) {
    if (error.code === 'EXDEV') return 'failed'; // the cache and the lane are on different volumes: install as today
    throw error;
  }
}

/**
 * Replaces `<folder>/node_modules` with a clone of the cache entry `key`, pinned by a reader file while it clones (see the header).
 * @param {string} commonDir the absolute git common dir of the repository
 * @param {string} key from depsKey
 * @param {string} folder the lockfile's folder in a lane, never in the main checkout
 * @returns {'cloned'|'missing'|'failed'} missing: no entry; failed: cloning is not possible here, or a prune took the entry mid-clone
 *   (`<folder>` untouched), or the cache is on another volume than the lane (`<folder>/node_modules` is gone)
 * @throws {Error} when the reader file or temp cannot be made, or a rename or delete fails for a reason other than being gone
 */
export function cloneFromCache(commonDir, key, folder) {
  const entry = join(commonDir, CACHE_FOLDER, key);
  const reader = join(entry, READERS_FOLDER, String(process.pid));
  if (!writeReader(reader)) return 'missing';
  const temp = tempPathOf(entry);
  try {
    mkdirSync(temp);
    const clone = join(temp, DEPENDENCY_FOLDER);
    if (!cloneTree(join(entry, DEPENDENCY_FOLDER), clone).ok || !isThere(reader)) return 'failed';
    return moveIntoLane(clone, join(folder, DEPENDENCY_FOLDER));
  } finally {
    removeTree(temp);
    rmSync(reader, { force: true });
  }
}

/** Renames a finished temp to its entry; 'exists' when another save got there first, 'failed' when a prune took the temp. */
function publish(temp, entry) {
  try {
    renameSync(temp, entry);
    return 'saved';
  } catch (error) {
    removeTree(temp);
    if (isThere(entry)) return 'exists';
    if (error.code === 'ENOENT') return 'failed';
    throw error;
  }
}

/**
 * Saves `<folder>/node_modules` as the cache entry `key`, written once through a temp and a rename (see the header).
 * @param {string} commonDir the absolute git common dir of the repository
 * @param {string} key from depsKey
 * @param {string} folder the lockfile's folder, right after its install wrote the marker
 * @returns {'saved'|'exists'|'failed'} exists: the key has an entry already; failed: no node_modules folder to save (missing or a
 *   link), cloning is not possible here, or a prune took the temp
 * @throws {Error} when the cache folder cannot be made, or a rename or delete fails for a reason other than being gone
 */
export function saveToCache(commonDir, key, folder) {
  const source = join(folder, DEPENDENCY_FOLDER);
  const entry = join(commonDir, CACHE_FOLDER, key);
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) return 'failed';
  if (isThere(entry)) return 'exists';
  const temp = tempPathOf(entry);
  mkdirSync(join(temp, READERS_FOLDER), { recursive: true });
  if (!cloneTree(source, join(temp, DEPENDENCY_FOLDER)).ok) {
    removeTree(temp);
    return 'failed';
  }
  return publish(temp, entry);
}

/** True for a temp older than TEMP_MAX_AGE_MS, or an entry unused for UNUSED_MAX_AGE_MS that no live process reads. */
function isPrunable(path, nowMs) {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) return false; // entries and temps are folders; anything else is not the cache's
  if (basename(path).includes(TEMP_INFIX)) return nowMs - stats.mtimeMs > TEMP_MAX_AGE_MS;
  const readers = join(path, READERS_FOLDER);
  return ageMs(readers, nowMs) > UNUSED_MAX_AGE_MS && !namesIn(readers).some(isLiveReader);
}

/** Renames the folder to a fresh temp, then deletes it; false when it was gone already. */
function removeFolder(path) {
  const doomed = tempPathOf(path);
  try {
    renameSync(path, doomed);
  } catch (error) {
    if (error.code === 'ENOENT') return false; // another prune, or the save that owned this temp, got there first
    throw error;
  }
  removeTree(doomed);
  return true;
}

/**
 * Removes what the cache no longer needs: temps older than an hour, entries unused for 7 days with no live reader (see the header).
 * @param {string} commonDir the absolute git common dir of the repository
 * @param {number} [nowMs] the clock (tests)
 * @returns {{ removed: number }} how many folders this call removed
 * @throws {Error} when a folder cannot be listed, renamed or deleted for a reason other than being gone
 */
export function pruneCache(commonDir, nowMs = Date.now()) {
  const cache = join(commonDir, CACHE_FOLDER);
  let removed = 0;
  for (const name of namesIn(cache)) {
    const path = join(cache, name);
    if (isPrunable(path, nowMs) && removeFolder(path)) removed += 1;
  }
  return { removed };
}
