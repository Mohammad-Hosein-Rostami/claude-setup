// Purpose: read one change from git for the smart check: the repo top, the lane base, the changed files (committed since the base,
//   uncommitted and new untracked ones) and their `-U0` diff in the shape of review-tier's parsePatch.
// Exports: gitOf(cwd), gitTop(cwd), laneBase(git, requested), changedPaths(git, base), readChange(git, base, paths),
//   newFileReader(top), oldFileReader(git, base), MAX_FILES.
// Invariants: every git call has a timeout and GIT_OPTIONAL_LOCKS=0 (a Stop hook must never take or wait on the index lock); nothing
//   here writes to the repo; a failed git call returns empty output, never throws, so the caller sees "no change" and passes. A new
//   untracked file counts as all added lines; files over MAX_FILE_BYTES are listed with no lines (binary or generated).
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePatch } from '../../review-tier/lib/diff.mjs';

const GIT_TIMEOUT_MS = 10_000; // one git read; a slower repo is reported as not checked, never waited on
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024; // larger new files are generated or binary: listed, not read
export const MAX_FILES = 400; // past this the change is "spread out" and its diff is not read line by line
const BASE_BRANCHES = ['main', 'master', 'develop'];

/**
 * A git runner bound to one folder.
 * @param {string} cwd the folder git runs in
 * @returns {{cwd: string, run: (args: string[]) => {ok: boolean, out: string}}}
 */
export function gitOf(cwd) {
  const run = (args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    return { ok: result.status === 0, out: result.status === 0 ? result.stdout : '' };
  };
  return { cwd, run };
}

/** The top folder of the work tree that holds `cwd`, or null outside a git repo (or when git is missing). */
export function gitTop(cwd) {
  const { ok, out } = gitOf(cwd).run(['rev-parse', '--show-toplevel']);
  return ok && out.trim() ? out.trim() : null;
}

/**
 * Where the lane starts: the requested ref, else HEAD on a base branch (or a detached HEAD), else the merge-base of HEAD with the
 * first local base branch. A repo with no commit yet has no base (null: every file counts as new).
 * @param {{run: Function}} git from gitOf
 * @param {string} [requested] a ref the caller names (`--base`)
 * @returns {string | null} a full sha
 */
export function laneBase(git, requested) {
  const sha = (ref) => { const { ok, out } = git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ok ? out.trim() : null; };
  if (requested) return sha(requested);
  const head = sha('HEAD');
  if (head === null) return null;
  const branch = git.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
  if (branch === '' || BASE_BRANCHES.includes(branch)) return head;
  for (const name of BASE_BRANCHES) {
    if (sha(`refs/heads/${name}`) === null) continue;
    const { ok, out } = git.run(['merge-base', 'HEAD', `refs/heads/${name}`]);
    if (ok && out.trim()) return out.trim();
  }
  return head;
}

const zList = (text) => text.split('\0').filter(Boolean);

/**
 * Every path changed since `base`: commits, staged and unstaged edits, and untracked files git does not ignore.
 * @param {{run: Function}} git from gitOf
 * @param {string | null} base from laneBase (null: every tracked and untracked file)
 * @returns {{tracked: string[], untracked: string[]}} repo-relative paths with forward slashes
 */
export function changedPaths(git, base) {
  const tracked = base === null ? zList(git.run(['ls-files', '-z']).out) : zList(git.run(['diff', '--name-only', '--no-renames', '-z', base, '--']).out);
  const untracked = zList(git.run(['ls-files', '--others', '--exclude-standard', '-z']).out);
  return { tracked, untracked };
}

/** The text of a file in the work tree, or null when it is gone, not a plain file, or larger than MAX_FILE_BYTES. */
export const newFileReader = (top) => (path) => {
  try {
    const full = join(top, path);
    const stat = lstatSync(full);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync(full, 'utf8') : null;
  } catch {
    return null;
  }
};

/** The text of a file at `base`, or null when it did not exist there. */
export const oldFileReader = (git, base) => (path) => {
  if (base === null) return null;
  const { ok, out } = git.run(['show', `${base}:${path}`]);
  return ok ? out : null;
};

/** An untracked file as an all-added entry. */
function addedWhole(path, readNew) {
  const text = readNew(path);
  const lines = text === null ? [] : text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { path, added: lines.map((line, index) => ({ line: index + 1, text: line })), removed: [], hunkHeads: [], isNew: true };
}

/**
 * The diff of `paths` against `base`, one entry per path; untracked paths come whole. A path with no hunk (binary, mode change) has
 * empty line lists.
 * @param {{cwd: string, run: Function}} git from gitOf (cwd = the repo top)
 * @param {string | null} base the lane base
 * @param {{tracked: string[], untracked: string[]}} paths the paths to read (a subset of changedPaths)
 * @returns {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[], isNew: boolean}[]}
 */
export function readChange(git, base, paths) {
  const readNew = newFileReader(git.cwd);
  const tracked = paths.tracked.slice(0, MAX_FILES);
  const parsed = tracked.length === 0 || base === null ? [] : parsePatch(git.run(['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', base, '--', ...tracked]).out);
  const byPath = new Map(parsed.map((file) => [file.path, file]));
  const readOld = oldFileReader(git, base);
  const trackedEntries = tracked.map((path) => {
    const entry = byPath.get(path) ?? { path, added: [], removed: [], hunkHeads: [] };
    return { ...entry, isNew: base === null || (entry.removed.length === 0 && readOld(path) === null) };
  });
  const untracked = paths.untracked.slice(0, Math.max(0, MAX_FILES - tracked.length)).map((path) => addedWhole(path, readNew));
  return [...trackedEntries, ...untracked];
}
