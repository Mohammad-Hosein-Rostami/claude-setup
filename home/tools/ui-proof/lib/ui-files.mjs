// Purpose: the one definition of "UI files" (for the ui-proof stop hook, `ui-proof changed`, `git-tidy land` and the road gate) and the
// hash of a tree's UI files, at a commit or in the working tree. Exports: isUiPath, isCoreUiPath, isUiRepoAt,
// uiEntriesAt, workingUiEntries, uiTreeHash, uiTreeAt, workingUiTree, changedUiFiles, git.
// Definition: the skill router's isUiFile (markup and style files), `.astro`, `.svelte`, `.vue` and `.mdx` files, `.ts`/`.js` style
// scripts under a styles/style/theme/themes/sx folder or named *.styles.ts, *.theme.ts, *.sx.ts (F3), and `.js` files whose text has
// a JSX tag or a react, react-native or expo import (React, React Native and Expo keep JSX in .js), minus anything under a folder
// named test, tests, __tests__ or fixtures; in a repo that has such a file (at either sha), also every package.json, its lockfile and
// the files under a locales/locale/i18n/lang folder.
// Invariants: git runs with plumbing commands, fixed flags and a timeout; a failed git call throws (callers fail closed); the hash is
// over sorted `path NUL blob-id` lines, so the same files give the same hash at a commit and in a clean working tree. A `.js` file
// that is not read (over MAX_SCRIPT_BYTES, over the tree's read budget, not a plain file) counts as UI, never as not UI (P3); working
// tree files are read without waiting (hooks/lib/plain-file.mjs: a FIFO or link is refused, not followed).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isUiFile } from '../../../hooks/skill-router.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { readBlobs } from './git-read.mjs';

const GIT_TIMEOUT_MS = 5000; // per call; the stop hook's own timeout is 15 s
const GIT_MAX_BUFFER = 64 << 20;
const TEST_FOLDER = /(^|\/)(test|tests|__tests__|fixtures)\//i;
const STYLE_FOLDER = /(^|\/)(styles?|themes?|sx)\//i;
const STYLE_NAME = /\.(styles?|theme|sx)\.m?[jt]s$/i;
const SCRIPT = /\.m?[jt]s$/i;
const PACKAGE_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const LOCALE_FOLDER = /(^|\/)(locales?|i18n|lang)\//i;
const FRAMEWORK_FILE = /\.(?:astro|svelte|vue|mdx)$/i; // framework files the router's isUiFile does not all name
const PLAIN_JS = /\.js$/i; // a .js file is UI by its text (JSX in .js: React, React Native, Expo)
const MAX_SCRIPT_BYTES = 1 << 20; // a larger .js is not read: it counts as UI
const MAX_TREE_SCRIPT_BYTES = 16 << 20; // .js text read per tree; past it every .js counts as UI (the stop hook has 15 s)
// A JSX tag where an expression starts (`return <p>`, `(<View`, `= <>`), or an import or require of react, react-native or expo.
// Linear: each `\s*` starts after one fixed character or a line start.
const JSX_OR_UI_IMPORT = /(?:^|[(=?:,&|{}]|\breturn)\s*<(?:\/?[A-Za-z][\w.:-]*(?:\s|\/?>)|>)|\b(?:from|import|require\s*\()\s*['"](?:react|react-native|expo)['"/]/m;
export const NO_UI_TREE = 'none'; // the hash of a tree without UI files

/** True when a script's text renders: a JSX tag or a react, react-native or expo import. @param {string} text untrusted file text */
const rendersByText = (text) => JSX_OR_UI_IMPORT.test(text);

/**
 * Run git in `cwd`. @returns {string} stdout @throws {Error} when git fails or times out (the message names the command)
 */
export function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, input });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? result.stderr ?? '').trim().split('\n')[0]}`);
  return result.stdout;
}

/** A markup, framework, style or style-script file outside a test folder (by its path alone): what makes a repo a UI repo. */
export const isCoreUiPath = (file) => !TEST_FOLDER.test(file)
  && (isUiFile(file) || FRAMEWORK_FILE.test(file) || (SCRIPT.test(file) && (STYLE_FOLDER.test(file) || STYLE_NAME.test(file))));

/** A UI file; `uiRepo` = the repo has a core UI file at either sha, which adds package files, lockfiles and locale files. */
export const isUiPath = (file, uiRepo) => isCoreUiPath(file) || (uiRepo && !TEST_FOLDER.test(file) && (PACKAGE_FILE.test(file) || LOCALE_FOLDER.test(file)));

/** A .js file whose text decides whether it is UI. */
const isScriptToRead = (file) => PLAIN_JS.test(file) && !TEST_FOLDER.test(file) && !isCoreUiPath(file);

/** Map path -> {blob, size, link} of every file at `rev`. */
function filesAt(cwd, rev) {
  const out = git(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', rev]);
  const files = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, blob, size] = entry.slice(0, tab).split(/ +/);
    if (type === 'blob') files.set(entry.slice(tab + 1), { blob, size: Number(size), link: mode === '120000' });
  }
  return files;
}

/**
 * The .js paths that count as UI, given each one's size or null when it is no plain file (a link): text that renders, and every one
 * not read (null, over MAX_SCRIPT_BYTES, or all of them past the tree's read budget). `readText(file)` returns its text, or null when
 * it could not be read (it then counts as UI).
 */
function uiScripts(sizes, readText) {
  const readable = [...sizes].filter(([, size]) => size !== null && size <= MAX_SCRIPT_BYTES);
  if (readable.reduce((sum, [, size]) => sum + size, 0) > MAX_TREE_SCRIPT_BYTES) return new Set(sizes.keys());
  const read = new Map(readable.map(([file]) => [file, readText(file)]));
  return new Set([...sizes.keys()].filter((file) => !read.has(file) || read.get(file) === null || rendersByText(read.get(file))));
}

/** The .js paths of a commit's files that count as UI (uiScripts); a link counts as one not read. */
function uiScriptsAt(cwd, files) {
  const scripts = [...files].filter(([file]) => isScriptToRead(file));
  const texts = readBlobs(cwd, scripts.filter(([, e]) => !e.link && e.size <= MAX_SCRIPT_BYTES).map(([, e]) => e.blob));
  return uiScripts(new Map(scripts.map(([file, e]) => [file, e.link ? null : e.size])), (file) => texts.get(files.get(file).blob) ?? null);
}

/** The .js paths of the working tree that count as UI (uiScripts); read without waiting, a link or FIFO counts as one not read. */
function uiScriptsIn(top, present) {
  const sizes = new Map(present.filter(isScriptToRead).map((file) => {
    const stats = fs.lstatSync(path.join(top, file), { throwIfNoEntry: false });
    return [file, stats?.isFile() ? stats.size : null];
  }));
  return uiScripts(sizes, (file) => {
    try {
      return readPlainFile(path.join(top, file), MAX_SCRIPT_BYTES);
    } catch {
      return null; // changed since lstat, a link or a FIFO now: not read, so it counts as UI (P3)
    }
  });
}

/** True when a commit has a UI file (core by path, or a .js that renders): the repo renders at that rev. */
export const isUiRepoAt = (cwd, rev) => {
  const files = filesAt(cwd, rev);
  return [...files.keys()].some(isCoreUiPath) || uiScriptsAt(cwd, files).size > 0;
};

/** Map path -> blob id of the UI files at `rev`. */
export function uiEntriesAt(cwd, rev) {
  const files = filesAt(cwd, rev);
  const scripts = uiScriptsAt(cwd, files);
  const hasUi = scripts.size > 0 || [...files.keys()].some(isCoreUiPath);
  return new Map([...files].filter(([file]) => scripts.has(file) || isUiPath(file, hasUi)).map(([file, entry]) => [file, entry.blob]));
}

/** Map path -> blob id of the UI files in the working tree (tracked and untracked, ignored files left out). */
export function workingUiEntries(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const listed = git(top, ['ls-files', '-z', '-c', '-o', '--exclude-standard']).split('\0').filter(Boolean);
  const present = [...new Set(listed)].filter((file) => fs.existsSync(path.join(top, file)));
  const scripts = uiScriptsIn(top, present);
  const hasUi = scripts.size > 0 || present.some(isCoreUiPath);
  const ui = present.filter((file) => scripts.has(file) || isUiPath(file, hasUi)).sort();
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
  const scripts = new Set([...uiScriptsAt(cwd, before), ...uiScriptsAt(cwd, after)]);
  const uiRepo = scripts.size > 0 || [...before.keys(), ...after.keys()].some(isCoreUiPath);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => before.get(file)?.blob !== after.get(file)?.blob && (scripts.has(file) || isUiPath(file, uiRepo))).sort();
}
