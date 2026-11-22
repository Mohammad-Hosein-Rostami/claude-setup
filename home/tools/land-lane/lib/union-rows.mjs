// Purpose: two checks of the rebased tip that `land-lane` makes before `git-tidy land` fast-forwards the base: every object the tip needs is in
// the repository, and no file marked `merge=union` holds a table row key twice. Union merge keeps both sides' lines, so two lanes that each
// added the same row (docs/catalog.md) rebase "cleanly" into a duplicate that nothing else would notice.
// Exports: verifyTipObjects(repo, tipSha), unionDuplicateKeys(repo, files, rev), changedUnionFiles(repo, base, tip),
//   checkTipRows(options, rebased) (the step: throws a Stop), EXIT_DUPLICATE_ROWS.
// Invariants: every git call is a subprocess with no shell and the default git timeout (lib/tools.mjs). Attributes come from `git check-attr
//   --source=<rev>` (the tip's own .gitattributes, no parser of ours) and file text from `git cat-file blob <rev>:<file>`, never from a working
//   folder that may not be at the tip. A git call that fails or cannot run is exit 14, never a pass (P3). A row key is the first cell of a table
//   row, trimmed, so a CRLF checkout and an LF one give the same key (F2). Keys printed in a stop are control-free and capped (F1).
import { git, firstLine } from './tools.mjs';
import { stop } from './stop.mjs';

export const EXIT_DUPLICATE_ROWS = 12; // the first land-lane exit free after 11 (disk) and before 13 (row not closed)
const UNION = 'union';
const FILES_PER_CHECK_ATTR = 200; // keeps the argument list far below the OS limit (about 32 KB on Windows)
const MAX_KEY_CHARS = 60;
const MAX_KEYS_PER_FILE = 5;
const MAX_FILES_NAMED = 5;
const TABLE_HEAD_ROWS = 2; // the header row and the `| --- |` row under it
const MISSING_PREFIX = '?'; // `rev-list --missing=print` puts it before the id of a missing object
const OBJECT_ID = /[0-9a-f]{40,64}/;
const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/**
 * Checks that the tip and everything it reaches (commits, trees, blobs) is in the repository.
 * @param {string} repo the repository folder
 * @param {string} tipSha the commit to check
 * @returns {{ ok: true } | { ok: false, object: string }} the first missing object (the tip itself when it is not a commit)
 * @throws {import('./stop.mjs').Stop} exit 14 when git cannot run
 */
export function verifyTipObjects(repo, tipSha) {
  const walk = git(repo, ['rev-list', '--objects', '--missing=print', tipSha, '--']);
  if (walk.status === null) return stop(14, 'tool-failed', `git could not check the objects of ${tipSha}: ${firstLine(walk)}`);
  if (!walk.ok) return { ok: false, object: walk.err.match(OBJECT_ID)?.[0] ?? tipSha };
  const missing = walk.out.split('\n').find((line) => line.startsWith(MISSING_PREFIX));
  return missing === undefined ? { ok: true } : { ok: false, object: missing.slice(MISSING_PREFIX.length).trim() };
}

/** Splits a table row into trimmed cells; `\|` stays inside a cell. */
const cellsOf = (line) => line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());

/** The row keys (first cells) that appear twice in one table of `text`; the header and separator rows are not rows. */
function duplicateRowKeys(text) {
  const duplicates = new Set();
  let seen = null;
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) { seen = null; continue; }
    if (seen === null) { seen = new Set(); skipped = 0; }
    if (skipped < TABLE_HEAD_ROWS) { skipped += 1; continue; }
    const [key] = cellsOf(line);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

/** A key as it is printed: no control characters, at most MAX_KEY_CHARS characters. */
const printable = (key) => {
  const clean = [...key].map((char) => (char.charCodeAt(0) <= LAST_CONTROL_CODE || char.charCodeAt(0) === DELETE_CODE ? ' ' : char)).join('');
  return clean.length > MAX_KEY_CHARS ? `${clean.slice(0, MAX_KEY_CHARS)}...` : clean;
};

/**
 * The duplicated first-cell row keys of each file.
 * @param {string} repo the repository folder
 * @param {string[]} files repo-relative paths (all of them are read; pass the `merge=union` ones)
 * @param {string} [rev] the commit the files are read from, default HEAD
 * @returns {{ file: string, keys: string[] }[]} only files with a duplicate; keys are control-free and capped
 * @throws {import('./stop.mjs').Stop} exit 14 when a file cannot be read
 */
export function unionDuplicateKeys(repo, files, rev = 'HEAD') {
  const found = [];
  for (const file of files) {
    const blob = git(repo, ['cat-file', 'blob', `${rev}:${file}`]);
    if (!blob.ok) stop(14, 'tool-failed', `git could not read ${file} at ${rev}: ${firstLine(blob)}`);
    const keys = duplicateRowKeys(blob.out).map(printable);
    if (keys.length > 0) found.push({ file, keys: keys.slice(0, MAX_KEYS_PER_FILE) });
  }
  return found;
}

/** The files the lane changed or added (not deleted) between its merge base with `base` and `tip`, as repo-relative paths. */
function changedFiles(repo, base, tip) {
  const diff = git(repo, ['diff', '--name-only', '-z', '--diff-filter=d', `${base}...${tip}`, '--']);
  if (!diff.ok) stop(14, 'tool-failed', `git could not list the files of ${tip}: ${firstLine(diff)}`);
  return diff.out.split('\0').filter((name) => name !== '');
}

/** The subset of `files` that the tip's .gitattributes marks `merge=union` (`git check-attr --source`, in chunks). */
function unionFiles(repo, tip, files) {
  const union = [];
  for (let start = 0; start < files.length; start += FILES_PER_CHECK_ATTR) {
    const chunk = files.slice(start, start + FILES_PER_CHECK_ATTR);
    const attrs = git(repo, ['check-attr', `--source=${tip}`, '-z', 'merge', '--', ...chunk]);
    if (!attrs.ok) stop(14, 'tool-failed', `git could not read the merge attributes at ${tip}: ${firstLine(attrs)}`);
    const parts = attrs.out.split('\0');
    for (let at = 0; at + 2 < parts.length; at += 3) if (parts[at + 2] === UNION) union.push(parts[at]);
  }
  return union;
}

/**
 * The `merge=union` files the lane changed (the only ones a union merge can have joined).
 * @param {string} repo the repository folder
 * @param {string} base the base ref or sha
 * @param {string} tip the lane's rebased tip
 * @returns {string[]} repo-relative paths
 */
export const changedUnionFiles = (repo, base, tip) => unionFiles(repo, tip, changedFiles(repo, base, tip));

/**
 * The step before the landing: the tip's objects are all there, and no union file of the lane holds a row key twice.
 * @param {{ repo: string, base: string }} options the parsed arguments
 * @param {string} rebased the lane's tip after the rebase check
 * @throws {import('./stop.mjs').Stop} exit 14 (a missing object, a git failure) or EXIT_DUPLICATE_ROWS naming the keys
 */
export function checkTipRows(options, rebased) {
  const objects = verifyTipObjects(options.repo, rebased);
  if (!objects.ok) stop(14, 'tip-objects-missing', `object ${objects.object} of ${rebased} is not in ${options.repo}: nothing was landed`);
  const duplicates = unionDuplicateKeys(options.repo, changedUnionFiles(options.repo, `refs/heads/${options.base}`, rebased), rebased);
  if (duplicates.length === 0) return;
  const lines = duplicates.slice(0, MAX_FILES_NAMED).map(({ file, keys }) => `${file}: duplicated row key ${keys.map((key) => `"${key}"`).join(', ')}`);
  stop(EXIT_DUPLICATE_ROWS, 'duplicate-rows', 'a merge=union file holds the same table row twice after the rebase (union merge kept both):', ...lines,
    'nothing was landed; the lane is rebased onto the base: remove the duplicate row, commit, and land again');
}
