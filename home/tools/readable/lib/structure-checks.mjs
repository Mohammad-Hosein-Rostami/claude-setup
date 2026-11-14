// Purpose: the three checks that only need the list of file paths: a folder with no README, a dumping-ground name,
//   and a tree nested too deep (rules C32, C34, C26).
// Exports: SOURCE_EXTENSIONS, DUMPING_NAMES, MAX_DEPTH, MIN_FILES_FOR_README, isSourceFile, findMissingReadmes,
//   findDumpingNames, findDeepNesting, FILE_DUMPING_NAMES.
// Invariants: pure; framework paths and names (see exemptions.mjs) are never reported; paths are posix, relative to the project root. Every finding is
//   {path, line, rule, check, message, fix, files}; `files` are the files the finding is about, so `--changed` can keep
//   or drop it.

import { countedDepth, isFrameworkFolder } from './exemptions.mjs';

export const SOURCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'c', 'cpp', 'h', 'swift', 'sh',
]);
export const DUMPING_NAMES = new Set(['misc', 'common', 'shared', 'utils', 'util', 'helpers', 'helper', 'stuff', 'tmp', 'temp', 'new', 'old', 'data']);
export const MAX_DEPTH = 5; // counted folders between the project root and a file (see countedDepth)
// A file called new, old, data, common or shared is normal (Rails new.html.erb, i18n common.json), so files get a shorter list.
export const FILE_DUMPING_NAMES = new Set(['misc', 'utils', 'util', 'helpers', 'helper', 'stuff', 'tmp', 'temp']);
export const MIN_FILES_FOR_README = 3;

const README_NAME = /^readme(\.[a-z]+)?$/i;
const extensionOf = (path) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** True for files in a language we check headers and README counts for. Declaration and minified files are not source. */
export function isSourceFile(path) {
  const name = baseName(path);
  if (name.endsWith('.d.ts') || name.includes('.min.')) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(name));
}

/** C34 and C26: a folder with 3 or more source files needs a README. */
export function findMissingReadmes(files) {
  const byFolder = new Map();
  for (const path of files) {
    const entry = byFolder.get(folderOf(path)) ?? { sources: [], hasReadme: false };
    if (isSourceFile(path)) entry.sources.push(path);
    if (README_NAME.test(baseName(path))) entry.hasReadme = true;
    byFolder.set(folderOf(path), entry);
  }
  const findings = [];
  for (const [folder, { sources, hasReadme }] of byFolder) {
    if (hasReadme || sources.length < MIN_FILES_FOR_README) continue;
    findings.push({
      path: folder === '' ? './' : `${folder}/`, line: 1, rule: 'C34', check: 'no-readme', files: sources,
      message: `${sources.length} source files and no README.`,
      fix: 'add a README.md that says what this folder is for and how to run and test it.',
    });
  }
  return findings;
}

/** C32: a file or folder named misc, utils, helpers and so on, unless the project allow-listed it with a reason. */
export function findDumpingNames(files, allowed = new Set()) {
  const folders = new Map();
  const findings = [];
  const flag = (path, name, kind, filesInside) => findings.push({
    path, line: 1, rule: 'C32', check: 'dumping-ground', kind: kind.toLowerCase(), files: filesInside,
    message: `${kind} name "${name}" says nothing about what is inside.`,
    fix: 'rename it for what it holds (a feature or domain word), or list it in .readable.json with a reason.',
  });
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      folders.set(folder, [...(folders.get(folder) ?? []), file]);
    }
    const stem = baseName(file).split('.')[0].toLowerCase();
    if (FILE_DUMPING_NAMES.has(stem) && !allowed.has(file) && !isFrameworkFolder(folderOf(file) || '.')) flag(file, baseName(file), 'File', [file]);
  }
  for (const [folder, inside] of folders) {
    if (DUMPING_NAMES.has(baseName(folder).toLowerCase()) && !allowed.has(folder) && !isFrameworkFolder(folder)) flag(`${folder}/`, baseName(folder), 'Folder', inside);
  }
  return findings;
}

/** C32: more than MAX_DEPTH folders between the project root and a file. One finding per too-deep folder. */
export function findDeepNesting(files) {
  const tooDeep = new Map();
  for (const file of files) {
    const folders = file.split('/').slice(0, -1);
    if (countedDepth(folders) <= MAX_DEPTH) continue;
    const folder = folders.slice(0, MAX_DEPTH + 1).join('/');
    tooDeep.set(folder, [...(tooDeep.get(folder) ?? []), file]);
  }
  return [...tooDeep].map(([folder, inside]) => ({
    path: `${folder}/`, line: 1, rule: 'C32', check: 'deep-nesting', files: inside,
    message: `nested more than ${MAX_DEPTH} folders deep (framework paths do not count).`,
    fix: 'flatten: move it up, or merge folders that only hold one folder.',
  }));
}
