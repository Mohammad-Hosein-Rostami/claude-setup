// The repositories the board may run git in (lead decisions of fix rounds 4 and 5, 2026-11-22): the session folder's and the setup's
// own (the repository holding this running code, found from this module's real path: `~/.claude/tools` links into it, and no agent's
// text can choose it). Claude Code's folder-trust record is not a source: the owner runs with bypass permissions, so it is unreliable,
// and it would widen what can name a folder. Git runs a repository's own config (`core.fsmonitor`, clean filters), so it never runs in a
// folder only an agent or a file it wrote named (review SEC-1 of 9ac483c3 and its residual).
// Exports: trustedRepos({ sessionFolder }) -> { session, repos: [{ common, folder, roots }] }; repoOfDir(repos, dir);
// worktreeRecords(common) -> [{ path, gitDir, branch, main }]; REMOTE_PATH.
// Each trusted folder (real path, disk case: review N-10) is placed in its repository by the file system alone (the `.git` entry of
// the folder or a parent; a worktree's `.git` file names its git folder, whose `commondir` names the shared one). The repository's
// worktrees are what it records itself (worktreeRecords: the main checkout with `<common>`, and each `<common>/worktrees/<name>`
// whose `gitdir` back-link names `<path>/.git`): git-state.mjs runs git in them only with that recorded git folder (`--git-dir`,
// `--work-tree`), so a worktree's own `.git` is never read, by git or here (reviews SEC-6 and N-9). An agent's folder (its edits,
// its launch worktree, its cwd) is matched to them by path prefix only: no file in an agent's folder is read. Worked out again on every refresh, never
// read back from a cache (review SEC-10: the board cache is a plain file any same-user process can write).
// Invariants: never throws; no git call here; `.git`, `commondir` and `gitdir` files are read without following a link or waiting on
// a FIFO, at most MAX_GIT_FILE_BYTES each (hooks/lib/plain-file.mjs); a UNC or device path is never touched.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

/** UNC `\\host\share`, `//host/share` and the mixed `/\host`, `\/host` (review SEC-8): a lookup there would reach another host. */
export const REMOTE_PATH = /^[\\/]{2}/;
const MAX_WORKTREES_READ = 32;
const MAX_FOLDER_DEPTH = 40;
const MAX_GIT_FILE_BYTES = 4096;

const entryOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };
const firstLine = (path) => { try { return readPlainFile(path, MAX_GIT_FILE_BYTES).split('\n')[0].trim(); } catch { return ''; } };
/** The real path in the disk's letter case (APFS is case-insensitive; `realpathSync` keeps the input's case: review N-10). */
const realOf = (path) => { try { return realpathSync.native(path); } catch { return null; } };
const isLocalFolder = (dir) => typeof dir === 'string' && dir !== '' && isAbsolute(dir) && !REMOTE_PATH.test(dir);
const isInside = (dir, path) => dir === path || dir.startsWith(`${path}${sep}`);

/** The shared git folder of the repository holding `folder` (fs only), or null outside a repository. */
function commonDirOf(folder) {
  let at = folder;
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth += 1) {
    const dotGit = join(at, '.git');
    const entry = entryOf(dotGit);
    if (entry?.isDirectory()) return dotGit;
    if (entry?.isFile()) {
      const named = /^gitdir: (.+)$/.exec(firstLine(dotGit))?.[1];
      if (!named) return null;
      const gitDir = isAbsolute(named) ? named : resolve(at, named);
      if (REMOTE_PATH.test(gitDir)) return null;
      const commonLine = firstLine(join(gitDir, 'commondir'));
      const common = commonLine ? resolve(gitDir, commonLine) : gitDir;
      return REMOTE_PATH.test(common) ? null : common; // a `commondir` naming `\\host\share` (review SEC-12)
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/** The branch a git folder's HEAD names (`ref: refs/heads/<branch>`), null when detached or unreadable. */
const branchOf = (gitDir) => /^ref: refs\/heads\/(.+)$/.exec(firstLine(join(gitDir, 'HEAD')))?.[1] ?? null;
const isFolder = (path) => entryOf(path)?.isDirectory() === true;

/**
 * The worktrees the repository records itself, the main checkout first: [{ path, gitDir, branch, main }]. Read fresh from `<common>`
 * (never from a cache, never from a worktree's own `.git`); a recorded folder that is gone is left out.
 * @param {string} common the repository's shared git folder
 * @returns {{ path: string, gitDir: string, branch: string | null, main: boolean }[]} at most MAX_WORKTREES_READ
 */
export function worktreeRecords(common) {
  const records = basename(common) === '.git' && isFolder(dirname(common))
    ? [{ path: dirname(common), gitDir: common, branch: branchOf(common), main: true }] : [];
  let names = [];
  try {
    names = readdirSync(join(common, 'worktrees')).slice(0, MAX_WORKTREES_READ);
  } catch {
    return records; // no linked worktrees
  }
  for (const name of names) {
    const gitDir = join(common, 'worktrees', name);
    const gitFile = firstLine(join(gitDir, 'gitdir'));
    // resolve: git writes forward slashes on Windows too, the agents' folders have backslashes (review N-8)
    const path = isLocalFolder(gitFile) && basename(gitFile) === '.git' ? resolve(dirname(gitFile)) : null;
    if (path !== null && isFolder(path)) records.push({ path, gitDir, branch: branchOf(gitDir), main: false });
  }
  return records;
}

/** The folder of this module with every link resolved (inside the setup's repository); null when it cannot be resolved. */
const codeFolder = () => { const real = realOf(fileURLToPath(import.meta.url)); return real === null ? null : dirname(real); };

/**
 * @param {{ sessionFolder: string | null }} source the session's folder
 * @returns {{ session: object | null, repos: { common: string, folder: string, roots: string[] }[] }} the session folder's repository
 *   (also first in repos), then the setup's; `folder` is where git may run for that repository (a trusted folder, never an agent's)
 */
export function trustedRepos({ sessionFolder }) {
  try {
    const byCommon = new Map();
    const session = isLocalFolder(sessionFolder) ? realOf(sessionFolder) : null;
    for (const folder of [session, codeFolder()].filter(isLocalFolder)) {
      const common = commonDirOf(folder);
      if (common !== null && !byCommon.has(common)) byCommon.set(common, { common, folder, roots: worktreeRecords(common).map((wt) => wt.path) });
    }
    const repos = [...byCommon.values()];
    return { session: repos.find((repo) => repo.folder === session) ?? null, repos };
  } catch {
    return { session: null, repos: [] };
  }
}

/** @returns {object | undefined} the trusted repository one of whose registered worktrees holds `dir` (the deepest one) */
export function repoOfDir(repos, dir) {
  if (!isLocalFolder(dir)) return undefined;
  let best;
  let bestLength = -1;
  for (const repo of repos) {
    for (const root of repo.roots) {
      if (isInside(dir, root) && root.length > bestLength) {
        best = repo;
        bestLength = root.length;
      }
    }
  }
  return best;
}
