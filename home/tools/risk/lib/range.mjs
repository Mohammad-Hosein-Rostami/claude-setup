// The files and lines a range of commits changes, for the risk command: which files differ between a base and a tip (or the
// worktree), which lines of one file changed, and the text of a file at the tip.
// Exports: rangeScope(repo, base, tip) -> Promise<{ top, base, tip, files, git }>; changedLines(top, base, file, tip) ->
//   Promise<[start, end][]>; fileText(top, file, tip) -> string.
// Invariants:
// - git runs without a shell and hardened (../../../hooks/lib/gated-folder.mjs `runGit`): no program the repository names runs.
// - The base is the merge base of the given base and the tip (as `git diff base...tip` reads it), so a base branch that moved on
//   does not count its own new commits as the change.
// - A bad revision, a folder that is not a repository or a failed git call throws; nothing is ever read as "no change".
import { join } from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { runGit } from '../../../hooks/lib/gated-folder.mjs';

const GIT_TIMEOUT_MS = 30_000; // one git call; normally a few ms
const MAX_FILE_BYTES = 2 * 1024 * 1024; // a file read for the comment-only test; a bigger one keeps its class
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all'];

/** git's stdout in `cwd`; a non-zero exit, a timeout or a missing git throws with git's first message line. */
function git(cwd, args) {
  const result = runGit(cwd, ['--literal-pathspecs', ...args], GIT_TIMEOUT_MS);
  if (result.status === 0) return result.stdout;
  const message = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n')[0];
  throw new Error(`git ${args[0]} failed: ${message}`);
}

const nulList = (text) => text.split('\0').filter(Boolean);

/** The full id of the commit `rev` names; a revision that starts with `-` or names no commit throws. */
function commitOf(top, rev) {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new Error(`not a revision: ${JSON.stringify(rev)}`);
  const result = runGit(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], GIT_TIMEOUT_MS);
  if (result.status !== 0) throw new Error(`no commit named ${JSON.stringify(rev)}`);
  return result.stdout.trim();
}

/**
 * The changed files between `base` and `tip`, or between `base` and the worktree (untracked files included) when `tip` is null.
 * @param {string} repo a folder inside the repository
 * @param {string} base a revision (branch, tag or sha)
 * @param {string|null} tip a revision, or null for the worktree
 * @returns {Promise<{ top: string, base: string, tip: string|null, files: string[], git: true }>} `base` and `tip` as full ids;
 *   `files` repo-relative with `/`, sorted
 * @throws {Error} not a repository, a bad revision or a failed git call
 */
export async function rangeScope(repo, base, tip) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const tipId = tip === null ? null : commitOf(top, tip);
  const mergeBase = git(top, ['merge-base', commitOf(top, base), tipId ?? 'HEAD']).trim();
  const changed = nulList(git(top, ['diff', '--name-only', '-z', ...DIFF_FLAGS, mergeBase, ...(tipId ? [tipId] : []), '--']));
  const untracked = tipId ? [] : nulList(git(top, ['ls-files', '-z', '--others', '--exclude-standard']));
  return { top, base: mergeBase, tip: tipId, files: [...new Set([...changed, ...untracked])].sort(), git: true };
}

/**
 * The lines of `file` that differ from `base` at `tip` (or in the worktree, an untracked file as a whole).
 * @param {string} top the worktree
 * @param {string} base the base commit (full id)
 * @param {string} file repo-relative path
 * @param {string|null} [tip] the tip commit (full id), or null for the worktree
 * @returns {Promise<[number, number][]>} 1-based inclusive ranges in file order; a pure deletion gives none
 * @throws {Error} a failed git call (an answer of "no lines" would hide a code change)
 */
export async function changedLines(top, base, file, tip = null) {
  const diff = git(top, ['diff', '-U0', ...DIFF_FLAGS, base, ...(tip ? [tip] : []), '--', file]);
  const ranges = [...diff.matchAll(HUNK_HEADER)].map(([, start, count]) => [Number(start), Number(start) + Number(count ?? 1) - 1])
    .filter(([start, end]) => end >= start);
  if (diff !== '' || tip) return ranges;
  if (!nulList(git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', file])).includes(file)) return [];
  const text = fileText(top, file, null);
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return lines > 0 ? [[1, lines]] : [];
}

/** The text of `file` at `tip`, or in the worktree when `tip` is null; throws when it cannot be read. */
export function fileText(top, file, tip) {
  return tip ? git(top, ['cat-file', 'blob', `${tip}:${file}`]) : readPlainFile(join(top, file), MAX_FILE_BYTES);
}
