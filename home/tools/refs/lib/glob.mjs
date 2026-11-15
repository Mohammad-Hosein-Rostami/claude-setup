// Purpose: answer "does this glob match anything" against real directory entries (case-exact), for workspace patterns,
//   Dockerfile COPY sources and CI paths.
// Exports: globMatches.
// Invariants: supports `*`, `**`, `?`, `[abc]` and `{a,b}`; `**` never descends into symlinked or skipped folders. A
//   pattern without glob characters is looked up entry by entry, so a case-only difference does not match.
import { join, resolve } from 'node:path';
import { SKIPPED_FOLDERS } from './walk.mjs';

const REGEX_SPECIAL = /[.+^$()|\\]/g;

/** Expands the first `{a,b}` group repeatedly: `x/{a,b}/*` gives `x/a/*` and `x/b/*`. */
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  const close = open === -1 ? -1 : pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern.slice(open + 1, close).split(',').flatMap((choice) => expandBraces(head + choice + tail));
}

function segmentToRegex(segment) {
  const source = segment.replace(REGEX_SPECIAL, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
  return new RegExp(`^${source}$`, 'u');
}

function matchSegments(disk, folder, segments, dirsOnly) {
  if (segments.length === 0) return true;
  const [head, ...rest] = segments;
  if (head === '' || head === '.') return matchSegments(disk, folder, rest, dirsOnly);
  if (head === '..') return matchSegments(disk, resolve(folder, '..'), rest, dirsOnly);
  const entries = disk.entries(folder);
  if (head === '**') {
    const deeper = entries.some((entry) => entry.isDir && !SKIPPED_FOLDERS.has(entry.name) && matchSegments(disk, join(folder, entry.name), segments, dirsOnly));
    return deeper || matchSegments(disk, folder, rest, dirsOnly);
  }
  const wanted = /[*?[]/.test(head) ? segmentToRegex(head) : null;
  return entries.some((entry) => {
    if (wanted === null ? entry.name !== head : !wanted.test(entry.name)) return false;
    if (rest.length === 0) return !dirsOnly || entry.isDir;
    return entry.isDir && matchSegments(disk, join(folder, entry.name), rest, dirsOnly);
  });
}

/**
 * True when the pattern matches at least one file or folder below `base`.
 * @param {import('./disk.mjs').Disk} disk
 * @param {string} base absolute folder the pattern is relative to
 * @param {string} pattern glob with `/` or `\` separators
 * @param {{dirsOnly?: boolean}} [options] dirsOnly: only folders count (workspace patterns)
 */
export function globMatches(disk, base, pattern, { dirsOnly = false } = {}) {
  return expandBraces(pattern.replaceAll('\\', '/')).some((alternative) => matchSegments(disk, base, alternative.split('/'), dirsOnly));
}
