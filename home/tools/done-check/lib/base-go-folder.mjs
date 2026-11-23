// The stable Go base folder of one repo (fixes spec X33, go-base): lib/base-run.mjs writes a Go base tree here instead of a new temp folder,
// so the folder path that Go's build cache keys hold stays the same across lanes, worktrees and rebases, and a second base is a cache hit.
// Exports: LOCK_HEARTBEAT_MS, LOCK_STALE_MS, STABLE_IDLE_MS, stableFolderOf(stateDir, commonDir), claimStableFolder(stateDir, commonDir).
// Layout: <stateDir>/base-go/<sha256 of the repo's real git common dir>/{tree,index,lock}: one folder per repo for all its worktrees.
// Invariants: the lock is lib/lock-file.mjs's (O_EXCL, a link or FIFO is never followed); its holder refreshes the lock's mtime every
//   LOCK_HEARTBEAT_MS, so only a lock left unrefreshed for LOCK_STALE_MS (a killed run) is ever broken, never a live holder's (P7). A release
//   removes the lock only while it is still the file this run made (same device and inode), and process exit releases what is held. Every
//   folder on the way is a real folder of this user (session-store privateFolder, never a link). P15: each claim removes, under their own
//   lock, other repos' folders whose tree was not made for STABLE_IDLE_MS (the 7 days of the base answer cache); a held folder is never removed.
import { createHash } from 'node:crypto';
import { lstatSync, lutimesSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { lstatOrNull, privateFolder, sameNode } from '../../../hooks/lib/session-store.mjs';
import { releaseLock, takeLock } from '../../disk-free/lib/lock-file.mjs';

const STABLE_FOLDER = 'base-go';
const STABLE_NAME = /^[0-9a-f]{64}$/;
const LOCK_NAME = 'lock';
const TREE_NAME = 'tree';
const INDEX_NAME = 'index';
/** How often the holder refreshes its lock's mtime while it holds it (ms). */
export const LOCK_HEARTBEAT_MS = 5_000;
/** A lock not refreshed for this long (12 missed refreshes) belongs to a killed run and may be broken (ms). */
export const LOCK_STALE_MS = 60_000;
/** A repo's stable folder whose tree was not made for this long is removed by the next claim of another repo (ms). */
export const STABLE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const heldLocks = new Set(); // the release functions of the locks this process holds
let exitHookSet = false;

/** Removes a folder; a failure is printed (a leftover must be seen) and the next claim tries again. */
function removeFolder(path) {
  try {
    rmSync(path, { recursive: true, force: true }); // links inside are removed, never followed
  } catch (error) {
    console.error(`done-check base-go-folder: could not remove ${path}: ${error.message}`);
  }
}

/** True while the lock file at `path` is still the one `mine` describes; false when it is gone, replaced or unreadable. */
function stillOwned(path, mine) {
  try {
    const now = lstatOrNull(path);
    return now !== null && sameNode(now, mine);
  } catch {
    return false; // unreadable: never touch or remove what may not be ours
  }
}

/** Takes the lock of one folder and refreshes it while held; null when someone else holds it. */
function holdLock(folder) {
  const path = join(folder, LOCK_NAME);
  if (!takeLock(path, Date.now(), LOCK_STALE_MS)) return null;
  const mine = lstatSync(path);
  const touch = () => {
    try {
      if (stillOwned(path, mine)) lutimesSync(path, new Date(), new Date()); // a fresh mtime tells others the holder is alive
    } catch (error) {
      console.error(`done-check base-go-folder: could not refresh ${path}: ${error.message}`); // it may then be taken as stale
    }
  };
  const beat = setInterval(touch, LOCK_HEARTBEAT_MS);
  beat.unref();
  const release = () => {
    if (!heldLocks.delete(release)) return;
    clearInterval(beat);
    try {
      if (stillOwned(path, mine)) releaseLock(path);
    } catch (error) {
      console.error(`done-check base-go-folder: could not release ${path}: ${error.message}`); // it goes stale after LOCK_STALE_MS
    }
  };
  heldLocks.add(release);
  if (!exitHookSet) {
    exitHookSet = true;
    process.once('exit', () => { for (const held of [...heldLocks]) held(); });
  }
  return release;
}

/** Removes one other repo's folder when its tree was not made for STABLE_IDLE_MS, under its lock (a held lock keeps it). */
function removeIfIdle(folder) {
  const info = lstatSync(folder);
  const usedMs = lstatOrNull(join(folder, TREE_NAME))?.mtimeMs ?? info.mtimeMs; // the tree folder is made anew on every use
  if (!info.isDirectory() || Date.now() - usedMs < STABLE_IDLE_MS) return;
  if (takeLock(join(folder, LOCK_NAME), Date.now(), LOCK_STALE_MS)) removeFolder(folder); // the lock goes with the folder
}

/** Removes the idle folders of other repos; one that vanished or cannot be read is named and left to the next claim. */
function sweepIdleFolders(parent, own) {
  for (const name of readdirSync(parent).filter((entry) => STABLE_NAME.test(entry) && join(parent, entry) !== own)) {
    try {
      removeIfIdle(join(parent, name));
    } catch (error) {
      console.error(`done-check base-go-folder: could not sweep ${join(parent, name)}: ${error.message}`);
    }
  }
}

/**
 * The stable folder of a repo.
 * @param {string} stateDir the done-check state folder (`<HOME>/.claude/state/done-check`)
 * @param {string} commonDir the repo's git common dir (any worktree of the repo gives the same one)
 * @returns {string} `<stateDir>/base-go/<sha256 of the real common dir>`
 * @throws {Error} when the common dir cannot be resolved
 */
export function stableFolderOf(stateDir, commonDir) {
  return join(stateDir, STABLE_FOLDER, createHash('sha256').update(realpathSync.native(commonDir)).digest('hex'));
}

/**
 * Locks the repo's stable folder for one base run, sweeps other repos' idle folders, and empties its tree and index for a refill.
 * @param {string} stateDir the done-check state folder, already checked to be a plain folder of this user
 * @param {string} commonDir the repo's git common dir
 * @returns {{ folder: string, release: () => void } | { unavailable: string }} `release` drops the lock and keeps the folder (twice is
 *   harmless); `base folder busy` when a live run holds it
 * @throws {Error} when a folder cannot be made or read (the caller answers unavailable)
 */
export function claimStableFolder(stateDir, commonDir) {
  const folder = stableFolderOf(stateDir, commonDir);
  const parent = join(stateDir, STABLE_FOLDER);
  if (privateFolder(parent) === undefined || privateFolder(folder) === undefined) return { unavailable: 'the stable base folder is not a plain folder of this user' };
  const release = holdLock(folder);
  if (release === null) return { unavailable: 'base folder busy' };
  try {
    sweepIdleFolders(parent, folder);
    for (const name of [TREE_NAME, INDEX_NAME]) rmSync(join(folder, name), { recursive: true, force: true });
    return { folder, release };
  } catch (error) {
    release();
    throw error;
  }
}
