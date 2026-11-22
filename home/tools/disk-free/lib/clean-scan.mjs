// Read-only file-system helpers for disk-clean. Exports: entriesOf, lstatOrNull, mtimeOf, walkTree, treeBytes, touchedSince, holdsGitWork.
// Invariants: nothing here follows a symlink (lstat and Dirent only); folders are read with opendir one entry at a time and a walk keeps
// only one open folder per level, so a folder of a million entries (or a planted one of many more) never fills the memory; a walk stops at
// a cap of entries and depth and says so. The removal itself is in safe-remove.mjs.
// holdsGitWork asks git (read-only: `config`, `status --no-optional-locks`, `rev-list`) with the board's GIT_SAFETY flags, no inherited
// GIT_* variable, the repository's git folder pinned and a time limit; whatever it cannot judge (git fails, a filter, a cut walk) is kept.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { GIT_SAFETY } from '../../board/lib/git-state.mjs';

export const MAX_WALK_ENTRIES = 2_000_000;
export const MAX_WALK_DEPTH = 64;
const BYTES_PER_BLOCK = 512;

/** Streams the entries (Dirent) of a folder; yields nothing when it cannot be read (missing folder, no permission). */
export async function* entriesOf(folder) {
  let handle;
  try {
    handle = await opendir(folder);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  }
  yield* handle;
}

/** lstat info without following a symlink; null when the path is gone or cannot be looked at (never throws: unknown means keep). */
export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Modification time (ms) without following a symlink; null when the path is gone or cannot be looked at. */
export const mtimeOf = (path) => lstatOrNull(path)?.mtimeMs ?? null;

/**
 * Streams the path and lstat info of a path and, for a folder, of everything under it (depth first, links never entered).
 * @param {string} root
 * @param {{ maxEntries?: number, maxDepth?: number }} limits
 * @param {{ cutShort?: boolean }} outcome set to cutShort=true when a limit or an unreadable folder left part of the tree unseen
 * @returns {AsyncGenerator<{ path: string, info: import('node:fs').Stats }>} the root first
 */
export async function* walkTree(root, { maxEntries = MAX_WALK_ENTRIES, maxDepth = MAX_WALK_DEPTH } = {}, outcome = {}) {
  const rootInfo = lstatOrNull(root);
  if (rootInfo === null) return;
  yield { path: root, info: rootInfo };
  if (!rootInfo.isDirectory()) return;
  const rootDir = await opendir(root).catch(() => null);
  if (rootDir === null) {
    outcome.cutShort = true;
    return;
  }
  const open = [{ dir: rootDir, path: root }];
  let seen = 0;
  try {
    while (open.length > 0) {
      const top = open.at(-1);
      const entry = await top.dir.read();
      if (entry === null) {
        open.pop();
        await top.dir.close();
        continue;
      }
      seen += 1;
      if (seen > maxEntries) {
        outcome.cutShort = true;
        return;
      }
      const path = join(top.path, entry.name);
      const info = lstatOrNull(path);
      if (info === null) continue;
      yield { path, info };
      if (!info.isDirectory()) continue;
      const dir = open.length >= maxDepth ? null : await opendir(path).catch(() => null);
      if (dir === null) outcome.cutShort = true;
      else open.push({ dir, path });
    }
  } finally {
    for (const { dir } of open) await dir.close().catch(() => {});
  }
}

/**
 * Bytes of a file or folder tree as lstat sees them (symlinks count as themselves, are never entered).
 * @param {string} path
 * @param {number} deadlineMs Date.now() value after which measuring stops
 * @returns {Promise<{ bytes: number, complete: boolean }>} complete is false when the deadline or a walk limit cut the walk short
 */
export async function treeBytes(path, deadlineMs) {
  let bytes = 0;
  const outcome = {};
  for await (const { info } of walkTree(path, {}, outcome)) {
    if (Date.now() > deadlineMs) return { bytes, complete: false };
    bytes += info.blocks === undefined ? info.size : info.blocks * BYTES_PER_BLOCK;
  }
  return { bytes, complete: outcome.cutShort !== true };
}

/**
 * True when the path, or anything anywhere under it, was modified after `cutoffMs` (stops at the first one found). Also true when the
 * path is gone or the walk was cut short: what cannot be seen counts as busy, so it is kept.
 * @param {string} path
 * @param {number} cutoffMs
 * @param {{ maxEntries?: number, maxDepth?: number }} limits the walk caps (tests make them small)
 */
export async function touchedSince(path, cutoffMs, limits = {}) {
  const outcome = {};
  let sawRoot = false;
  for await (const { info } of walkTree(path, limits, outcome)) {
    sawRoot = true;
    if (info.mtimeMs > cutoffMs) return true;
  }
  return !sawRoot || outcome.cutShort === true;
}

const GIT_ENTRY = '.git';
const GIT_TIMEOUT_MS = 20_000; // one read-only git call on a large clone; disk-clean --apply runs in the background
const REPOSITORY_SCOPES = new Set(['local', 'worktree']); // config that comes with the repository (as the board reads it)

/** stdout of one git call on the repository whose git folder is `gitDir`; null when git is missing, fails or runs out of time. */
function gitOutput(gitDir, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  try {
    return execFileSync('git', [...GIT_SAFETY, ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { ...env, GIT_COMMON_DIR: gitDir, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, // a `commondir` file cannot send git elsewhere
    });
  } catch {
    return null; // the caller keeps what git could not judge
  }
}

/**
 * True when the repository in `workTree` holds work found nowhere else, or cannot be judged: linked worktrees of it exist, its own config
 * names a filter (`status` would run it), it has uncommitted, staged or untracked-and-not-ignored changes, or a commit (a branch, tag,
 * detached HEAD or stash) that no remote-tracking branch holds.
 */
function repositoryHoldsWork(workTree, gitDir) {
  if (lstatOrNull(join(gitDir, 'worktrees')) !== null) return true; // its linked worktrees elsewhere depend on this git folder
  const git = (args) => gitOutput(gitDir, [`--git-dir=${gitDir}`, ...args]);
  const config = git(['config', '--list', '--name-only', '--show-scope']);
  const namesFilter = (line) => REPOSITORY_SCOPES.has(line.split('\t')[0]) && (line.split('\t')[1] ?? '').toLowerCase().startsWith('filter.');
  if (config === null || config.split('\n').some(namesFilter)) return true;
  const status = git([`--work-tree=${workTree}`, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
  if (status !== '') return true; // changes, or null: git could not tell
  const localOnly = git(['rev-list', '--count', '--all', '--not', '--remotes']);
  return localOnly === null || Number(localOnly.trim()) !== 0;
}

/**
 * True when the folder is or holds, at any depth, git work a removal would lose: a `.git` that is not a folder (a linked worktree or a
 * submodule, whose repository lives elsewhere and would keep a stale record), or a repository with work found nowhere else
 * (repositoryHoldsWork). Also true when the walk was cut short: what cannot be seen is kept.
 * @param {string} path a folder
 * @param {{ maxEntries?: number, maxDepth?: number }} limits the walk caps
 * @returns {Promise<boolean>}
 */
export async function holdsGitWork(path, limits = {}) {
  const outcome = {};
  for await (const entry of walkTree(path, limits, outcome)) {
    if (entry.path === path || basename(entry.path) !== GIT_ENTRY) continue;
    if (!entry.info.isDirectory() || repositoryHoldsWork(dirname(entry.path), entry.path)) return true;
  }
  return outcome.cutShort === true;
}
