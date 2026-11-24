// The size limit for new files and the brief test that lets one through, for `git-tidy land` (tools/git-tidy/lib/land-checks.mjs):
// a build output or a binary that a lane adds stops the land unless the lane's brief names its path.
// Exports: MAX_NEW_FILE_BYTES, namesPath(text, relPath, absPath).
// Invariants: pure; a path counts as named only as a whole word in the exact case.

/** Bytes; a source file is never this big. Changed only as a reviewed setup change. */
export const MAX_NEW_FILE_BYTES = 5 * 1024 * 1024;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` names the file by its repo-relative or absolute path as a whole word: exact case, not next to a letter, digit, `_`,
 * `.`, `/` or `-`.
 * @returns {boolean}
 */
export function namesPath(text, relPath, absPath) {
  if (typeof text !== 'string' || text === '') return false;
  return [relPath, absPath].filter((path) => typeof path === 'string' && path !== '')
    .some((path) => new RegExp(`(?<![\\w./-])${escapeRegExp(path)}(?![\\w./-])`).test(text));
}
