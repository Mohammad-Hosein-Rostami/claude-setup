// Purpose: the facts about a repository that `check` and `prune` read: base branch, upstream, worktrees, branches,
//   a half-finished operation, uncommitted files. Everything here only reads.
// Exports: openRepo, listWorktrees, listBranches, currentBranch, samePath, contains, inProgressOperation, changedFileCount,
//   ignoredFiles, minutesSinceUse.
// Invariants: branches are always addressed by full ref (`refs/heads/<name>`), so a tag with the same name is never
//   mistaken for a branch; every git call fails closed, a fact that cannot be read is reported as unknown, not as clean.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';
const BASE_FALLBACKS = ['main', 'master', 'develop'];
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';
// A file or folder inside a git dir that exists only while that operation is unfinished.
// Ignored files in these folders are build output or caches that any build recreates; elsewhere they may exist only here.
const REBUILDABLE_FOLDERS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '.nx', 'test-results', 'playwright-report', '.vite',
]);
// Files the operating system drops everywhere; losing them costs nothing.
const OS_CLUTTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const isClutter = (entry) => {
  const name = entry.split('/').filter((part) => part !== '').at(-1) ?? '';
  return OS_CLUTTER.has(name) || name.startsWith('._');
};
const MS_PER_MINUTE = 60_000;
const OPERATION_MARKERS = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['sequencer', 'cherry-pick'], ['BISECT_LOG', 'bisect'],
];

const branchExists = (dir, name) => runGit(dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${name}`]).status === 0;

const realPath = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** True when both paths are the same folder (symlinks and case resolved); a path that cannot be resolved is compared as written. */
export const samePath = (a, b) => realPath(a) === realPath(b);

/** True when `inner` is the folder `outer` or lies inside it (real paths compared). */
export function contains(outer, inner) {
  const [folder, candidate] = [realPath(outer), realPath(inner)];
  return candidate === folder || candidate.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

// The base and how it was chosen: `from --base`, `from origin/HEAD` or `fallback` (first of main, master, develop).
function resolveBase(dir, requested) {
  if (requested !== null) {
    if (!branchExists(dir, requested)) throw new UsageError(`base branch "${requested}" does not exist here; pass an existing one with --base <branch>`);
    return { name: requested, source: 'from --base' };
  }
  const originHead = runGit(dir, ['symbolic-ref', '-q', ORIGIN_HEAD]);
  const named = originHead.status === 0 ? originHead.stdout.trim().slice(ORIGIN_PREFIX.length) : '';
  if (named !== '' && branchExists(dir, named)) return { name: named, source: 'from origin/HEAD' };
  const fallback = BASE_FALLBACKS.find((name) => branchExists(dir, name));
  if (fallback === undefined) throw new UsageError('no base branch found (origin/HEAD, main, master, develop); pass one with --base <branch>');
  return { name: fallback, source: 'fallback' };
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
  const { name: base, source: baseSource } = resolveBase(dir, requestedBase);
  const knownBases = BASE_FALLBACKS.filter((name) => branchExists(dir, name));
  return { dir, bare, topLevel, base, baseSource, knownBases, baseRef: `${HEADS}${base}`, upstream: upstreamOf(dir, base) };
}

const GITDIR_LINE = /^gitdir: (.+)$/m;
const MAX_GITFILE_BYTES = 4096;

/**
 * When a linked worktree's lock was taken: the mtime of `locked` in its admin folder (named by the worktree's `.git` file), or null when
 * the folder is gone, the `.git` file is not a plain small file or the lock file cannot be read (r9-wt-lock: "stale lock?").
 */
function lockedAtMs(path) {
  try {
    const gitFile = join(path, '.git');
    const stats = lstatSync(gitFile);
    if (!stats.isFile() || stats.size > MAX_GITFILE_BYTES) return null;
    const admin = GITDIR_LINE.exec(readFileSync(gitFile, 'utf8'))?.[1]?.trim();
    return admin ? statSync(resolve(path, admin, 'locked')).mtimeMs : null;
  } catch {
    return null;
  }
}

/** Worktrees as `{ path, branch, detached, bare, locked, lockReason, lockedAtMs, missing, main }`; the first one is the main worktree. */
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
      else if (field === 'locked' || field.startsWith('locked ')) Object.assign(current, { locked: true, lockReason: field.slice('locked '.length).trim(), lockedAtMs: lockedAtMs(current.path) });
    }
  }
  return entries;
}

/** Local branches as `{ name, tip, short, date }` (full and abbreviated hash, date of the last commit as YYYY-MM-DD). */
export function listBranches(repo) {
  const output = gitText(repo.dir, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objectname:short)%00%(committerdate:short)', HEADS]);
  return output === '' ? [] : output.split('\n').map((line) => {
    const [ref, tip, short, date] = line.split('\0');
    return { name: ref.slice(HEADS.length), tip, short, date };
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

/**
 * Ignored files and folders in the worktree at `path` that a build would not recreate (a local `.env`, a `reports/` folder; not OS clutter such as `.DS_Store`),
 * as relative paths; null when git cannot say (callers treat null as "has some"). Folders are listed once, with a trailing `/`.
 */
export function ignoredFiles(path) {
  const listed = ignoredEntries(path, ['--directory']);
  if (listed === null) return null;
  const kept = [];
  for (const entry of listed) {
    // A listed folder holds only ignored files; look inside once, because it may hold nothing but OS clutter.
    const inside = entry.endsWith('/') ? ignoredEntries(path, ['--', entry]) : [entry];
    if (inside === null || inside.length > 0) kept.push(entry);
  }
  return kept;
}

// Ignored entries that matter (not rebuildable folders, not OS clutter); null when git fails.
function ignoredEntries(path, extraArgs) {
  const result = runGit(path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...extraArgs]);
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter((entry) => entry !== '' && !isClutter(entry) && !entry.split('/').some((part) => REBUILDABLE_FOLDERS.has(part)));
}

/**
 * Minutes since the worktree at `path` was last used, when that is less than `withinMinutes`, else null. Used means its HEAD
 * reflog, its index or any tracked file changed. When git cannot say it answers 0 (just used), so callers keep the worktree.
 */
export function minutesSinceUse(path, withinMinutes, now = Date.now()) {
  const gitDir = runGit(path, ['rev-parse', '--absolute-git-dir']);
  const tracked = runGit(path, ['ls-files', '-z']);
  if (gitDir.status !== 0 || tracked.status !== 0) return 0;
  const files = [join(gitDir.stdout.trim(), 'logs', 'HEAD'), join(gitDir.stdout.trim(), 'index'), ...tracked.stdout.split('\0').filter((name) => name !== '').map((name) => join(path, name))];
  const cutoff = now - withinMinutes * MS_PER_MINUTE;
  for (const file of files) {
    const modified = lstatSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (modified !== undefined && modified > cutoff) return Math.max(0, Math.floor((now - modified) / MS_PER_MINUTE));
  }
  return null;
}
