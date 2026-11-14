// Purpose: list the files of a project folder the way a developer sees them: no .git, no vendored or generated
//   folders, nothing .gitignore hides (the project's own and those of parent folders up to the repo root), symlinks not followed.
// Exports: SKIPPED_FOLDERS, listFiles(root).
// Invariants: returns posix paths relative to root, sorted; a nested .gitignore applies to its own folder only; when root
//   is a subfolder of a git repo, the .gitignore files above it apply too, as git would apply them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/**
 * Lists every file under root that git would not ignore.
 * @param {string} root absolute or relative folder
 * @returns {string[]} posix paths relative to root, sorted
 */
export function listFiles(root) {
  const found = [];
  const visit = (relFolder, layers) => {
    const folder = join(root, relFolder);
    const here = [...layers, { base: relFolder === '' ? '' : `${relFolder}/`, offset: '', rules: readRules(folder) }];
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relFolder === '' ? entry.name : `${relFolder}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !isIgnored(here, rel, true)) visit(rel, here);
      } else if (entry.isFile() && !isIgnored(here, rel, false)) found.push(rel);
    }
  };
  visit('', parentLayers(root));
  return found;
}
