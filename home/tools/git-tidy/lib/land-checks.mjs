// Purpose: the checks `git-tidy land` runs right before its fast-forward (spec-p3 `r9-land-speed`): new files over the size limit that the
//   lane's brief does not name, and the base tip before and after the fast-forward (the landed range `from..to`).
// Exports: oversizeAdded(repo, baseSha, tip, briefText) -> { path, bytes }[], landedFrom(repo, readBefore) -> string.
// Invariants: reads only; git runs as plumbing with fixed flags. The size limit and the path matching are the commit gate's own
//   (hooks/lib/new-file-size.mjs: one constant, one matcher, no second copy). A file already on the base never counts, since only files
//   the range `<base>..<tip>` adds are sized. No brief lists no path.
import { join } from 'node:path';
import { MAX_NEW_FILE_BYTES, namesPath } from '../../../hooks/lib/new-file-size.mjs';
import { gitText, runGit } from './git.mjs';

const LS_TREE_ENTRY = /^\d+ blob [0-9a-f]+ +(\d+)\t([^]*)$/;

/** Paths the range `baseSha..tip` adds (no renames, so a moved file counts as added). */
function addedPaths(repo, baseSha, tip) {
  const listed = gitText(repo.dir, ['diff-tree', '-r', '--no-renames', '--no-ext-diff', '--diff-filter=A', '--name-only', '-z', baseSha, tip]);
  return new Set(listed.split('\0').filter((path) => path !== ''));
}

/**
 * The files the lane adds that are over MAX_NEW_FILE_BYTES and that its brief does not name.
 * @param {object} repo the repository (openRepo)
 * @param {string} baseSha the base tip the lane was rebased onto
 * @param {string} tip the rebased lane tip
 * @param {string|null} briefText the lane's brief, or null (no brief: no path is listed)
 * @returns {{ path: string, bytes: number }[]}
 */
export function oversizeAdded(repo, baseSha, tip, briefText) {
  const added = addedPaths(repo, baseSha, tip);
  if (added.size === 0) return [];
  const big = [];
  for (const entry of gitText(repo.dir, ['ls-tree', '-r', '-l', '-z', tip]).split('\0')) {
    const match = LS_TREE_ENTRY.exec(entry);
    if (match === null || !added.has(match[2])) continue;
    const bytes = Number(match[1]);
    if (bytes > MAX_NEW_FILE_BYTES && !namesPath(briefText, match[2], join(repo.topLevel ?? repo.dir, match[2]))) big.push({ path: match[2], bytes });
  }
  return big;
}

/**
 * The base tip just before the fast-forward: `readBefore` (read right before `merge --ff-only`), unless the base's reflog says the entry
 * before the new tip is another commit (another process moved the base in between): then the reflog's value, so a commit put on the base
 * in between falls in no landed range.
 * @param {object} repo the repository (openRepo)
 * @param {string} readBefore the full sha read right before the merge
 * @returns {string} a full sha
 */
export function landedFrom(repo, readBefore) {
  const previous = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${repo.baseRef}@{1}`]);
  const fromReflog = previous.status === 0 ? previous.stdout.trim() : '';
  return fromReflog !== '' && fromReflog !== readBefore ? fromReflog : readBefore;
}

export { MAX_NEW_FILE_BYTES };
