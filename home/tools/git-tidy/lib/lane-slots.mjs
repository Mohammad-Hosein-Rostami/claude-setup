// Purpose: read a repository's lane folder pool: the folders `<main worktree>/.claude/worktrees/lane-<n>` and, for each, whether it is
//   free for the next lane, busy (with why) or missing (a worktree entry whose folder is gone).
// Exports: POOL_FOLDER, LOCK_REASON_PREFIX, poolFolderOf, commonDirOf, slotKey, isPoolSlot, contentBusyWhy, poolSlots, readSlot, lastUsedMs.
// Invariants: reads only. Every fact comes from git through runGit (no shell, `-z` lists, full shas) or lstat, and a fact that cannot
//   be read makes the folder busy, never free (fail closed). Slot paths are compared as real paths (realpathSync.native), case-folded on
//   win32 and darwin. A folder at a slot path that is not a worktree of this repository is busy and is never touched by any caller.
//   Free means: a linked worktree of this repository, unlocked, HEAD detached at a commit on the base, no unfinished operation, no git
//   lock file, `git status` (untracked files included) empty. Ignored files (node_modules, dist/, a local .env) do not make it busy.
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';
import { changedFileCount, inProgressOperation, listWorktrees } from './repo.mjs';

export const POOL_FOLDER = join('.claude', 'worktrees');
/** `git worktree lock --reason "cs-lane-pool <branch>"`: the lock a claim puts on the folder it hands out. */
export const LOCK_REASON_PREFIX = 'cs-lane-pool';
const FOLDED = process.platform === 'win32' || process.platform === 'darwin';
const SLOT_NAME = new RegExp('^lane-([1-9][0-9]{0,5})$', FOLDED ? 'i' : ''); // `Lane-2` is the same folder on a case-folding disk
const GIT_LOCK_FILES = ['index.lock', 'HEAD.lock'];
const USE_FILES = [join('logs', 'HEAD'), 'HEAD', 'index']; // what a switch, a commit or an add rewrites in the worktree's admin folder
const SHORT = 8;

/** The real path of `path`; for a missing path the real path of its nearest existing parent plus the rest (so /tmp and /private/tmp agree). */
function realOrParent(path) {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? resolve(path) : join(realOrParent(parent), basename(path));
  }
}

/** The form two folder paths are compared in: real path, lower case where the disk folds case. */
export const slotKey = (path) => (FOLDED ? realOrParent(path).toLowerCase() : realOrParent(path));

/** `<main worktree>/.claude/worktrees` (real path); a bare repository has no main worktree, so no pool (UsageError). */
export function poolFolderOf(repo, worktrees = listWorktrees(repo)) {
  const [main] = worktrees;
  if (main === undefined || main.bare || main.missing) throw new UsageError(`${repo.dir} has no main worktree folder, so it has no lane folders`);
  return join(realOrParent(main.path), POOL_FOLDER);
}

/** The absolute git common dir of the repository (shared by all its worktrees), where the pool lock lives. */
export const commonDirOf = (repo) => gitText(repo.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

/** True when `folder` is `<pool folder>/lane-<n>` of this repository (real paths compared). */
export function isPoolSlot(repo, folder, worktrees = listWorktrees(repo)) {
  return SLOT_NAME.test(basename(folder)) && slotKey(dirname(folder)) === slotKey(poolFolderOf(repo, worktrees));
}

/** The worktree's own admin folder (`.git/worktrees/<id>`), or null when git cannot say. */
function adminDirOf(path) {
  const result = runGit(path, ['rev-parse', '--absolute-git-dir']);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * What in the worktree at `tree.path` must not be switched away from: a git lock file, an unfinished operation, uncommitted or
 * untracked files, a HEAD with commits not on the base. Lock and branch are not looked at (release reads them itself).
 * @param {object} repo openRepo's result
 * @param {{ path: string }} tree the worktree
 * @returns {string|null} the reason, or null when nothing would be lost
 */
export function contentBusyWhy(repo, tree) {
  const admin = adminDirOf(tree.path);
  if (admin === null) return 'git cannot read it';
  const gitLock = GIT_LOCK_FILES.find((name) => existsSync(join(admin, name)));
  if (gitLock !== undefined) return `a git lock is held (${gitLock})`;
  const operation = inProgressOperation(tree.path);
  if (operation !== null) return `a ${operation} is not finished there`;
  const changed = changedFileCount(tree.path);
  if (changed === null) return 'git status failed there';
  if (changed > 0) return `${changed} uncommitted or untracked files`;
  const head = runGit(tree.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.status !== 0) return 'its HEAD cannot be read';
  const sha = head.stdout.trim();
  const landed = runGit(repo.dir, ['merge-base', '--is-ancestor', sha, repo.baseRef]);
  if (landed.status === 1) return `HEAD ${sha.slice(0, SHORT)} has commits that are not on ${repo.base}`;
  if (landed.status !== 0) return `git cannot tell whether HEAD ${sha.slice(0, SHORT)} is on ${repo.base}`;
  return null;
}

/** Why a registered, present worktree is busy, or null when it is free. */
function busyWhy(repo, tree) {
  if (tree.locked) return `locked${tree.lockReason ? ` (${tree.lockReason})` : ''}`;
  if (tree.branch !== null) return `holds branch ${tree.branch}, not locked (a claim stopped before its lock, or it was switched by hand)`;
  if (!tree.detached) return 'its HEAD is neither a branch nor detached';
  return contentBusyWhy(repo, tree);
}

/** A free slot's why: where its HEAD is. */
const freeWhy = (path) => `detached at ${(runGit(path, ['rev-parse', '--short', 'HEAD']).stdout.trim() || 'an unknown commit')}`;

/**
 * The state of one slot folder, every fact read now.
 * @param {object} repo openRepo's result
 * @param {string} folder the slot path `<pool>/lane-<n>`
 * @param {object[]} [worktrees] listWorktrees(repo), when the caller has just read it
 * @returns {{ slot: string, number: number, folder: string, state: 'free'|'busy'|'missing', why: string, branch: string|null }}
 */
export function readSlot(repo, folder, worktrees = listWorktrees(repo)) {
  const number = Number(SLOT_NAME.exec(basename(folder))?.[1]);
  const key = slotKey(folder);
  const tree = worktrees.find((entry) => !entry.main && slotKey(entry.path) === key);
  const stats = lstatSync(folder, { throwIfNoEntry: false });
  const slot = (state, why) => ({ slot: `lane-${number}`, number, folder, state, why, branch: tree?.branch ?? null });
  if (tree === undefined) return slot('busy', stats === undefined ? 'no folder and no worktree' : 'not a worktree of this repository: never touched');
  if (tree.missing || stats === undefined) return tree.locked ? slot('busy', 'its folder is gone, but its entry is locked') : slot('missing', 'its folder is gone (a stale worktree entry)');
  if (!stats.isDirectory()) return slot('busy', 'not a plain folder (a link or a file): never touched');
  const why = busyWhy(repo, tree);
  return why === null ? slot('free', freeWhy(folder)) : slot('busy', why);
}

/** The slot names in the pool folder (readdir), [] when the folder is missing. */
function slotNamesIn(folder) {
  try {
    return readdirSync(folder).filter((name) => SLOT_NAME.test(name));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * Every slot of the pool, lowest number first: each `lane-<n>` folder in the pool folder and each worktree entry at such a path
 * whose folder is gone.
 * @param {object} repo openRepo's result
 * @returns {ReturnType<typeof readSlot>[]}
 * @throws {UsageError} for a bare repository (no pool); Error when git cannot list the worktrees
 */
export function poolSlots(repo) {
  const worktrees = listWorktrees(repo);
  const pool = poolFolderOf(repo, worktrees);
  const poolKey = slotKey(pool);
  const folders = new Map(slotNamesIn(pool).map((name) => [slotKey(join(pool, name)), join(pool, name)]));
  for (const tree of worktrees.filter((entry) => !entry.main && SLOT_NAME.test(basename(entry.path)))) {
    if (slotKey(dirname(tree.path)) === poolKey && !folders.has(slotKey(tree.path))) folders.set(slotKey(tree.path), join(pool, basename(tree.path)));
  }
  return [...folders.values()].map((folder) => readSlot(repo, folder, worktrees)).sort((a, b) => a.number - b.number);
}

/**
 * When the slot was last used: the newest mtime of its HEAD reflog, HEAD and index (a claim, a commit, an add, a detach write them).
 * @param {string} folder a present worktree folder
 * @returns {number|null} ms since the epoch, or null when git or the file system cannot say (callers then treat it as just used)
 */
export function lastUsedMs(folder) {
  const admin = adminDirOf(folder);
  if (admin === null) return null;
  const times = USE_FILES.map((name) => lstatSync(join(admin, name), { throwIfNoEntry: false })?.mtimeMs).filter((time) => time !== undefined);
  return times.length === 0 ? null : Math.max(...times);
}
