// Purpose: list the files of a project folder the way a developer sees them: no .git, no vendored or generated
//   folders, nothing .gitignore hides, symlinks not followed.
// Exports: SKIPPED_FOLDERS, listFiles(root).
// Invariants: returns posix paths relative to root, sorted; a nested .gitignore applies to its own folder only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchRules, parseGitignore } from './ignore.mjs';

export const SKIPPED_FOLDERS = new Set([
  '.git', 'node_modules', 'vendor', 'bower_components', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', '.gradle', '.idea', 'generated',
]);

function readRules(folder) {
  const file = join(folder, '.gitignore');
  return existsSync(file) ? parseGitignore(readFileSync(file, 'utf8')) : [];
}

function isIgnored(layers, relPath, isDir) {
  let ignored = false;
  for (const layer of layers) {
    const inside = relPath.slice(layer.base.length);
    const verdict = matchRules(layer.rules, inside, isDir);
    if (verdict !== null) ignored = verdict;
  }
  return ignored;
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
    const here = [...layers, { base: relFolder === '' ? '' : `${relFolder}/`, rules: readRules(folder) }];
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relFolder === '' ? entry.name : `${relFolder}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !isIgnored(here, rel, true)) visit(rel, here);
      } else if (entry.isFile() && !isIgnored(here, rel, false)) found.push(rel);
    }
  };
  visit('', []);
  return found;
}
