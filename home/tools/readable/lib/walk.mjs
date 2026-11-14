// Purpose: list the files of a project folder the way a developer sees them: no .git, no vendored or generated
//   folders, nothing git ignores, no nested repository or linked worktree, symlinks not followed.
// Exports: SKIPPED_FOLDERS, listFiles(root).
// Invariants: returns posix paths relative to root, sorted. Inside a git repository the list comes from git itself
//   (`git ls-files --cached --others --exclude-standard`), so every ignore source counts: .gitignore at any level,
//   .git/info/exclude and the global excludes file. Outside a repository the folder is walked and only .gitignore files
//   are read (the folder's own, and those above it up to a repo root). A folder that holds its own `.git` (a nested
//   repository, a linked worktree, a submodule) is never entered.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { git } from './git-changes.mjs';
import { matchRules, parseGitignore } from './ignore.mjs';

export const SKIPPED_FOLDERS = new Set([
  '.git', 'node_modules', 'vendor', 'bower_components', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'generated',
  '__generated__', '.svelte-kit', '.output', 'Pods', '.dart_tool', '.yarn',
]);

function readRules(folder) {
  const file = join(folder, '.gitignore');
  return existsSync(file) ? parseGitignore(readFileSync(file, 'utf8')) : [];
}

/** A layer is one .gitignore: `base` is its folder inside the scan, `offset` the path from its folder down to the scan root. */
function isIgnored(layers, relPath, isDir) {
  let ignored = false;
  for (const layer of layers) {
    const verdict = matchRules(layer.rules, layer.offset + relPath.slice(layer.base.length), isDir);
    if (verdict !== null) ignored = verdict;
  }
  return ignored;
}

/** The .gitignore layers of the folders above `root`, up to the folder that holds `.git`. */
function parentLayers(root) {
  const start = resolve(root);
  let top = start;
  while (!existsSync(join(top, '.git')) && dirname(top) !== top) top = dirname(top);
  if (!existsSync(join(top, '.git'))) return [];
  const layers = [];
  for (let dir = dirname(start); start !== top; dir = dirname(dir)) {
    layers.unshift({ base: '', offset: `${relative(dir, start).split('\\').join('/')}/`, rules: readRules(dir) });
    if (dir === top) break;
  }
  return layers;
}

/** Files git knows (tracked, or untracked and not ignored) under root, or null when root is not in a work tree. */
function listWithGit(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listed.status !== 0) return null;
  const isRealFile = (path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true; // drops deleted files, folders (nested repos end in /), submodules and symlinks
  const inSkippedFolder = (path) => path.split('/').slice(0, -1).some((part) => SKIPPED_FOLDERS.has(part));
  const nestedRepos = new Map(); // folder -> holds its own .git; git itself misses a `.git` file that is not a valid link
  const isNestedRepo = (folder) => {
    if (!nestedRepos.has(folder)) nestedRepos.set(folder, existsSync(join(root, folder, '.git')));
    return nestedRepos.get(folder);
  };
  const inNestedRepo = (path) => {
    const parts = path.split('/').slice(0, -1);
    return parts.some((_, index) => isNestedRepo(parts.slice(0, index + 1).join('/')));
  };
  return [...new Set(listed.stdout.split('\0').filter(Boolean))]
    .filter((path) => isRealFile(path) && !inSkippedFolder(path) && !inNestedRepo(path)).sort();
}

/**
 * Lists every file under root that git would not ignore.
 * @param {string} root absolute or relative folder
 * @returns {string[]} posix paths relative to root, sorted
 */
export function listFiles(root) {
  const fromGit = listWithGit(root);
  if (fromGit !== null) return fromGit;
  const found = [];
  const visit = (relFolder, layers) => {
    const folder = join(root, relFolder);
    const here = [...layers, { base: relFolder === '' ? '' : `${relFolder}/`, offset: '', rules: readRules(folder) }];
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relFolder === '' ? entry.name : `${relFolder}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const isNestedRepo = existsSync(join(root, rel, '.git'));
        if (!SKIPPED_FOLDERS.has(entry.name) && !isNestedRepo && !isIgnored(here, rel, true)) visit(rel, here);
      } else if (entry.isFile() && !isIgnored(here, rel, false)) found.push(rel);
    }
  };
  visit('', parentLayers(root));
  return found;
}
