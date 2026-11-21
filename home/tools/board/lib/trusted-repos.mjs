// The repositories the board may run git in (fix rounds 3 and 4, lead decisions 2026-11-22): the session folder's, the setup's own
// (the repository holding this running code, found from this module's real path: `~/.claude/tools` links into it, and no agent's
// text can choose it; the owner runs with bypass permissions, so the trust dialog may never be shown), and the one of every folder
// whose Claude Code folder-trust dialog the owner accepted. Git runs a repository's own config (`core.fsmonitor`, clean
// filters), so it never runs in a folder only an agent or a file it wrote named (review SEC-1 of 9ac483c3 and its residual).
// Exports: trustedRepos({ sessionFolder, env, cache, nowMs }) -> { session, repos: [{ common, folder, roots }], cache };
// repoOfDir(repos, dir); REMOTE_PATH.
// Trust record: <CLAUDE_CONFIG_DIR, else HOME>/.claude.json, `projects[<absolute folder>].hasTrustDialogAccepted === true` (Claude
// Code's own file, internal format, field names read from the real file on 2026-11-22); read-only, as a regular file of at most
// MAX_RECORD_BYTES without following a link; only that one field of each entry is looked at, nothing of it is printed or kept.
// Each folder is placed in its repository by the file system alone (the `.git` entry of the folder or a parent; a worktree's `.git`
// file names its git folder, whose `commondir` names the shared one). `roots` are the repository's registered worktrees, read the
// same way (the main checkout, and `<common>/worktrees/<name>/gitdir`), so an agent's folder is matched to a trusted repository by
// path prefix only: no file in an agent's folder is ever read. The record's repositories are cached by the record's size and time
// and re-read at most every TRUST_EVERY_MS.
// Invariants: never throws; no git call here; `.git`, `commondir` and `gitdir` files are read without following a link or waiting on
// a FIFO, at most MAX_GIT_FILE_BYTES each (hooks/lib/plain-file.mjs); a UNC or device path is never touched.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

/** UNC `\\host\share`, `//host/share` and the mixed `/\host`, `\/host` (review SEC-8): a lookup there would reach another host. */
export const REMOTE_PATH = /^[\\/]{2}/;
const MAX_RECORD_BYTES = 8 * 1024 * 1024; // the record also holds per-project history; past this it is skipped, not read in part
const MAX_TRUSTED_FOLDERS = 500;
const MAX_WORKTREES_READ = 32;
const MAX_FOLDER_DEPTH = 40;
const MAX_GIT_FILE_BYTES = 4096;
const TRUST_EVERY_MS = 60_000; // a repository made in a trusted folder shows within a minute

const entryOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };
const firstLine = (path) => { try { return readPlainFile(path, MAX_GIT_FILE_BYTES).split('\n')[0].trim(); } catch { return ''; } };
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
      const common = firstLine(join(gitDir, 'commondir'));
      return common ? resolve(gitDir, common) : gitDir;
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/** The repository's registered worktree folders: its main checkout, then each `<common>/worktrees/<name>/gitdir` names one. */
function rootsOf(common) {
  const roots = basename(common) === '.git' ? [dirname(common)] : [];
  let names = [];
  try {
    names = readdirSync(join(common, 'worktrees')).slice(0, MAX_WORKTREES_READ);
  } catch {
    return roots; // no linked worktrees
  }
  for (const name of names) {
    const gitFile = firstLine(join(common, 'worktrees', name, 'gitdir'));
    if (isLocalFolder(gitFile) && basename(gitFile) === '.git') roots.push(dirname(gitFile));
  }
  return roots;
}

const recordPathOf = (env) => join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), '.claude.json');
/** The folder of this module with every link resolved (inside the setup's repository); null when it cannot be resolved. */
const codeFolder = () => { try { return dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { return null; } };
/** The record's size and time, so an unchanged record is not parsed again. */
const stampOf = (path) => { const info = entryOf(path); return info?.isFile() ? `${info.mtimeMs}:${info.size}` : 'none'; };

/** The folders of the trust record the owner accepted; [] when it is missing, a link, too big or not JSON. */
function recordFolders(path) {
  try {
    const projects = JSON.parse(readPlainFile(path, MAX_RECORD_BYTES))?.projects;
    if (projects === null || typeof projects !== 'object') return [];
    return Object.keys(projects).filter((folder) => projects[folder]?.hasTrustDialogAccepted === true && isLocalFolder(folder))
      .slice(0, MAX_TRUSTED_FOLDERS);
  } catch {
    return []; // nothing is trusted from a record that cannot be read whole
  }
}

/** The repositories of these folders, first folder of each kept: [{ common, folder, roots }]. */
function reposOf(folders) {
  const byCommon = new Map();
  for (const folder of folders.filter(isLocalFolder)) {
    const common = commonDirOf(folder);
    if (common !== null && !byCommon.has(common)) byCommon.set(common, { common, folder, roots: rootsOf(common) });
  }
  return [...byCommon.values()];
}

/**
 * @param {{ sessionFolder: string | null, env: object, cache: object | null, nowMs: number }} source the session's folder, the
 *   environment (HOME, CLAUDE_CONFIG_DIR), the last cache ({ stamp, atMs, repos }) and now
 * @returns {{ session: object | null, repos: { common: string, folder: string, roots: string[] }[], cache: object | null }} the
 *   session folder's repository (also first in repos), then the setup's, then the record's; `folder` is where git may run for that
 *   repository (a trusted folder, never an agent's)
 */
export function trustedRepos({ sessionFolder, env, cache, nowMs }) {
  try {
    const path = recordPathOf(env);
    const stamp = stampOf(path);
    const fresh = cache !== null && typeof cache === 'object' && Array.isArray(cache.repos) && cache.stamp === stamp
      && nowMs - cache.atMs < TRUST_EVERY_MS;
    const recordRepos = fresh ? cache.repos : reposOf(recordFolders(path));
    const repos = reposOf([sessionFolder, codeFolder()]);
    const session = repos.find((repo) => repo.folder === sessionFolder) ?? null;
    repos.push(...recordRepos.filter((repo) => !repos.some((known) => known.common === repo.common)));
    return { session, repos, cache: { stamp, atMs: fresh ? cache.atMs : nowMs, repos: recordRepos } };
  } catch {
    return { session: null, repos: [], cache: null };
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
