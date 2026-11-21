// Purpose: the one definition of "UI files" (for the ui-proof stop hook, `ui-proof changed`, `git-tidy land` and road gate 6) and the
// hash of a tree's UI files, at a commit or in the working tree. Exports: isUiPath, isCoreUiPath, uiEntriesAt, workingUiEntries,
// uiTreeHash, uiTreeAt, workingUiTree, changedUiFiles, git.
// Definition: the skill router's isUiFile (markup and style files) plus `.ts`/`.js` style scripts under a styles/style/theme/themes/sx
// folder or named *.styles.ts, *.theme.ts, *.sx.ts (F3), minus anything under a folder named test, tests, __tests__ or fixtures; in a
// repo that has such a file (at either sha), also every package.json, its lockfile and the files under a locales/locale/i18n/lang folder.
// Invariants: git runs with plumbing commands, fixed flags and a timeout; a failed git call throws (callers fail closed); the hash is
// over sorted `path NUL blob-id` lines, so the same files give the same hash at a commit and in a clean working tree.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isUiFile } from '../../../hooks/skill-router.mjs';

const GIT_TIMEOUT_MS = 5000; // per call; the stop hook's own timeout is 15 s
const GIT_MAX_BUFFER = 64 << 20;
const TEST_FOLDER = /(^|\/)(test|tests|__tests__|fixtures)\//i;
const STYLE_FOLDER = /(^|\/)(styles?|themes?|sx)\//i;
const STYLE_NAME = /\.(styles?|theme|sx)\.m?[jt]s$/i;
const SCRIPT = /\.m?[jt]s$/i;
const PACKAGE_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const LOCALE_FOLDER = /(^|\/)(locales?|i18n|lang)\//i;
export const NO_UI_TREE = 'none'; // the hash of a tree without UI files

/**
 * Run git in `cwd`. @returns {string} stdout @throws {Error} when git fails or times out (the message names the command)
 */
export function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, input });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? result.stderr ?? '').trim().split('\n')[0]}`);
  return result.stdout;
}

/** A markup, style or style-script file outside a test folder: what makes a repo a UI repo. */
export const isCoreUiPath = (file) => !TEST_FOLDER.test(file) && (isUiFile(file) || (SCRIPT.test(file) && (STYLE_FOLDER.test(file) || STYLE_NAME.test(file))));

/** A UI file; `uiRepo` = the repo has a core UI file at either sha, which adds package files, lockfiles and locale files. */
export const isUiPath = (file, uiRepo) => isCoreUiPath(file) || (uiRepo && !TEST_FOLDER.test(file) && (PACKAGE_FILE.test(file) || LOCALE_FOLDER.test(file)));

/** Map path -> blob id of every file at `rev`. */
function filesAt(cwd, rev) {
  const out = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  const files = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [, type, blob] = entry.slice(0, tab).split(' ');
    if (type === 'blob') files.set(entry.slice(tab + 1), blob);
  }
  return files;
}

/** Map path -> blob id of the UI files at `rev` (`uiRepo` decided at that rev unless given). */
export function uiEntriesAt(cwd, rev, uiRepo) {
  const files = filesAt(cwd, rev);
  const hasUi = uiRepo ?? [...files.keys()].some(isCoreUiPath);
  return new Map([...files].filter(([file]) => isUiPath(file, hasUi)));
}

/** Map path -> blob id of the UI files in the working tree (tracked and untracked, ignored files left out). */
export function workingUiEntries(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const listed = git(top, ['ls-files', '-z', '-c', '-o', '--exclude-standard']).split('\0').filter(Boolean);
  const present = [...new Set(listed)].filter((file) => fs.existsSync(path.join(top, file)));
  const hasUi = present.some(isCoreUiPath);
  const ui = present.filter((file) => isUiPath(file, hasUi)).sort();
  if (ui.length === 0) return new Map();
  const blobs = git(top, ['hash-object', '--stdin-paths'], `${ui.join('\n')}\n`).trim().split('\n');
  return new Map(ui.map((file, i) => [file, blobs[i]]));
}

/** The hash of a set of UI entries; NO_UI_TREE when there are none. */
export function uiTreeHash(entries) {
  if (entries.size === 0) return NO_UI_TREE;
  const lines = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, blob]) => `${file}\0${blob}`);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The UI tree hash at a commit. */
export const uiTreeAt = (cwd, rev) => uiTreeHash(uiEntriesAt(cwd, rev));

/** The UI tree hash of the working tree. */
export const workingUiTree = (cwd) => uiTreeHash(workingUiEntries(cwd));

/**
 * The UI files that differ between two commits (`ui-proof changed`).
 * @returns {string[]} sorted paths (added, changed or removed)
 */
export function changedUiFiles(cwd, from, to) {
  const before = filesAt(cwd, from);
  const after = filesAt(cwd, to);
  const uiRepo = [...before.keys(), ...after.keys()].some(isCoreUiPath);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => before.get(file) !== after.get(file) && isUiPath(file, uiRepo)).sort();
}
