// New files over the size limit for commit-gate.mjs (spec-p1-gates-fix 2.5, K12, K9', K14'): a build output or a binary that an agent
// adds and commits, or leaves untracked, blocks its stop and the lead's unless its brief (or, for the lead, the agents' listed record or
// an open STATUS.md row) names the path.
// Exports: MAX_NEW_FILE_BYTES, oversizeNewFiles(tree, baseline, ownEntries) -> files | null, namesPath(text, relPath, absPath),
//   unlistedFiles(files, {brief, listed, rows}), sizeReason(files).
// Invariants: git is plumbing with fixed flags and a timeout (P2); a git or read error is one stderr line and no size block (null);
//   no baseline head (a baseline from before round 9, or a branch move judged foreign by the caller) counts no committed file.
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gitOut } from './gated-folder.mjs';
import { realPathOf } from './own-edits.mjs';

/** Bytes; a source file is never this big. Changed only as a reviewed setup change. */
export const MAX_NEW_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SIZED_PATHS = 200;
const MAX_FOLDER_FILES = 200;
const MAX_SHOWN = 5;
const MAX_PATH_SHOWN_CHARS = 200;
const GIT_TIMEOUT_MS = 3000;
const BYTES_PER_MB = 1024 * 1024;
const LS_TREE_LINE = /^\d+ blob [0-9a-f]+ +(\d+)\t([^]*)$/;

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

/** Files added by commits since `head` and their sizes; null on a git error. */
function committedFiles(gitTop, top, head) {
  const added = gitOut(gitTop, ['diff-tree', '-r', '--no-renames', '--diff-filter=A', '--name-only', '-z', head, 'HEAD'], GIT_TIMEOUT_MS);
  if (added === null) return null;
  const paths = added.split('\0').filter((path) => path !== '');
  if (paths.length > MAX_SIZED_PATHS) process.stderr.write(`commit-gate: ${paths.length} new files since the baseline; sizing the first ${MAX_SIZED_PATHS}\n`);
  if (paths.length === 0) return [];
  const listed = gitOut(gitTop, ['--literal-pathspecs', 'ls-tree', '-l', '-z', 'HEAD', '--', ...paths.slice(0, MAX_SIZED_PATHS)], GIT_TIMEOUT_MS);
  if (listed === null) return null;
  return listed.split('\0').map((line) => LS_TREE_LINE.exec(line)).filter((found) => found !== null)
    .map(([, bytes, rel]) => ({ rel, abs: join(top, rel), bytes: Number(bytes) }));
}

/** The plain files of an own untracked or added entry (a folder: its files, at most MAX_FOLDER_FILES entries walked). */
function entryFiles(path) {
  const stats = lstatSync(path);
  if (stats.isFile()) return [{ abs: path, bytes: stats.size }];
  if (!stats.isDirectory()) return [];
  const files = [];
  const pending = [path];
  let seen = 0;
  while (pending.length > 0 && seen < MAX_FOLDER_FILES) {
    const dir = pending.pop();
    for (const name of readdirSync(dir).slice(0, MAX_FOLDER_FILES - seen)) {
      seen += 1;
      const child = lstatSync(join(dir, name));
      if (child.isDirectory()) pending.push(join(dir, name));
      else if (child.isFile()) files.push({ abs: join(dir, name), bytes: child.size });
    }
  }
  return files;
}

/**
 * The new files over MAX_NEW_FILE_BYTES: (a) added by commits since the baseline's head, (b) own untracked or added entries.
 * @param {{top: string, gitTop: string}} tree real worktree path, and the path git runs in
 * @param {{head: string | null} | null} baseline the caller passes head null when the branch move is another session's
 * @param {{field: string, path: string}[]} ownEntries the stop's own dirty entries (lib/change-owner.mjs)
 * @returns {{rel: string, abs: string, real: string, bytes: number}[] | null} null on a git or read error (one stderr line)
 */
export function oversizeNewFiles(tree, baseline, ownEntries) {
  try {
    const committed = typeof baseline?.head === 'string' ? committedFiles(tree.gitTop, tree.top, baseline.head) : [];
    if (committed === null) {
      process.stderr.write('commit-gate: cannot list the files added since the baseline\n');
      return null;
    }
    const added = ownEntries.filter(({ field }) => field.startsWith('??') || field[0] === 'A')
      .flatMap(({ path }) => entryFiles(path.endsWith(sep) ? path.slice(0, -1) : path))
      .map(({ abs, bytes }) => ({ rel: relative(tree.top, abs).split(sep).join('/'), abs, bytes }));
    const big = [...committed, ...added].filter(({ bytes }) => bytes > MAX_NEW_FILE_BYTES);
    const seen = new Set();
    return big.map((file) => ({ ...file, real: realPathOf(file.abs) })).filter(({ real }) => !seen.has(real) && seen.add(real));
  } catch (error) {
    process.stderr.write(`commit-gate: cannot size new files: ${error.message}\n`);
    return null;
  }
}

/**
 * The files no source lists: the brief (an agent's first user message), the agents' `listed` record or an open STATUS.md row.
 * @param {{rel: string, abs: string, real: string}[]} files
 * @param {{brief?: string | null, listed?: Set<string>, rows?: string[]}} sources
 */
export function unlistedFiles(files, { brief = null, listed = new Set(), rows = [] }) {
  return files.filter(({ rel, abs, real }) => !namesPath(brief, rel, abs) && !listed.has(real) && !rows.some((row) => namesPath(row, rel, abs)));
}

/** The block reason: at most MAX_SHOWN paths, each quoted and capped (P5). */
export function sizeReason(files) {
  const shown = files.slice(0, MAX_SHOWN).map(({ rel, bytes }) => `${JSON.stringify(rel.slice(0, MAX_PATH_SHOWN_CHARS))} (${(bytes / BYTES_PER_MB).toFixed(1)} MB)`);
  return `New files over 5 MB that your brief does not list: ${shown.join(', ')}: take them out of the change and of your commits, or ask for the path to be listed.`;
}
