// Purpose: the facts about a repository that `check` and `prune` read: base branch, upstream, worktrees, branches,
//   a half-finished operation, uncommitted files. Everything here only reads.
// Exports: openRepo, listWorktrees, listBranches, currentBranch, samePath, inProgressOperation, changedFileCount.
// Invariants: branches are always addressed by full ref (`refs/heads/<name>`), so a tag with the same name is never
//   mistaken for a branch; every git call fails closed, a fact that cannot be read is reported as unknown, not as clean.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';
const BASE_FALLBACKS = ['main', 'master', 'develop'];
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';
// A file or folder inside a git dir that exists only while that operation is unfinished.
const OPERATION_MARKERS = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['sequencer', 'cherry-pick'], ['BISECT_LOG', 'bisect'],
];

const branchExists = (dir, name) => runGit(dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${name}`]).status === 0;

/** True when both paths are the same folder (symlinks and case resolved); a path that cannot be resolved is compared as written. */
export function samePath(a, b) {
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(a) === real(b);
}

function resolveBase(dir, requested) {
  if (requested !== null) {
    if (!branchExists(dir, requested)) throw new UsageError(`base branch "${requested}" does not exist here; pass an existing one with --base <branch>`);
    return requested;
  }
  const originHead = runGit(dir, ['symbolic-ref', '-q', ORIGIN_HEAD]);
  const named = originHead.status === 0 ? originHead.stdout.trim().slice(ORIGIN_PREFIX.length) : '';
  const found = [named, ...BASE_FALLBACKS].find((name) => name !== '' && branchExists(dir, name));
  if (found === undefined) throw new UsageError('no base branch found (origin/HEAD, main, master, develop); pass one with --base <branch>');
  return found;
}

function upstreamOf(dir, base) {
  const result = runGit(dir, ['rev-parse', '--symbolic-full-name', `${base}@{upstream}`]);
  if (result.status !== 0) return null;
  const ref = result.stdout.trim();
  return { ref, name: ref.replace(/^refs\/remotes\//, '') };
}

/** Finds the repository containing `dir` and its base branch. Throws UsageError for a missing folder, a non-repo or no base. */
export function openRepo(dir, requestedBase) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${dir} is not a folder`);
  const inside = runGit(dir, ['rev-parse', '--is-bare-repository']);
  if (inside.status !== 0) throw new UsageError(`${dir} is not inside a git repository`);
  const bare = inside.stdout.trim() === 'true';
  const topLevel = bare ? null : runGit(dir, ['rev-parse', '--show-toplevel']).stdout.trim() || null;
  const base = resolveBase(dir, requestedBase);
  return { dir, bare, topLevel, base, baseRef: `${HEADS}${base}`, upstream: upstreamOf(dir, base) };
}

/** Worktrees as `{ path, branch, detached, bare, locked, missing, main }`; the first one is the main worktree. */
export function listWorktrees(repo) {
  const entries = [];
  let current = null;
  for (const field of gitText(repo.dir, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: null, detached: false, bare: false, locked: false, main: entries.length === 0 };
      current.missing = !existsSync(current.path);
      entries.push(current);
    } else if (current !== null) {
      if (field.startsWith('branch ' + HEADS)) current.branch = field.slice(('branch ' + HEADS).length);
      else if (field === 'detached') current.detached = true;
      else if (field === 'bare') current.bare = true;
      else if (field === 'locked' || field.startsWith('locked ')) current.locked = true;
    }
  }
  return entries;
}

/** Local branches as `{ name, tip, short }` (full and abbreviated hash). */
export function listBranches(repo) {
  const output = gitText(repo.dir, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objectname:short)', HEADS]);
  return output === '' ? [] : output.split('\n').map((line) => {
    const [ref, tip, short] = line.split('\0');
    return { name: ref.slice(HEADS.length), tip, short };
  });
}

/** The branch HEAD points at in the folder the tool was given, or null when detached. */
export function currentBranch(repo) {
  const result = runGit(repo.dir, ['symbolic-ref', '-q', 'HEAD']);
  return result.status === 0 ? result.stdout.trim().slice(HEADS.length) : null;
}

/** `rebase`, `merge`, `cherry-pick`, `revert` or `bisect` when that operation is unfinished in the worktree at `path`, else null. */
export function inProgressOperation(path) {
  const result = runGit(path, ['rev-parse', '--absolute-git-dir']);
  if (result.status !== 0) return null;
  const gitDir = result.stdout.trim();
  return OPERATION_MARKERS.find(([marker]) => existsSync(join(gitDir, marker)))?.[1] ?? null;
}

/** Number of changed or untracked paths in the worktree at `path`, or null when git cannot say (callers treat null as dirty). */
export function changedFileCount(path) {
  // Explicit flags: the user's `status.showUntrackedFiles=no` or `diff.ignoreSubmodules` must not hide anything here.
  const result = runGit(path, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (result.status !== 0) return null;
  return result.stdout.split('\n').filter((line) => line !== '').length;
}
