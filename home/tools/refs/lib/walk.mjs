// Purpose: list the files and folders of the scanned directory, hidden folders (.github, .cursor, .claude) included.
// Exports: SKIPPED_FOLDERS, walkTree.
// Invariants: symlinks are never followed and never listed, so a loop or a link out of the directory cannot be entered.
//   Returns posix paths relative to root, sorted. A folder that cannot be read becomes a problem, never an exception;
//   only the root itself throws.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.nx', '.next', '.turbo', '.cache']);

/**
 * @param {string} root folder to walk
 * @returns {{files: string[], folders: string[], problems: {path: string, reason: string}[]}}
 * @throws when the root cannot be read
 */
export function walkTree(root) {
  const files = [];
  const folders = [];
  const problems = [];
  const pending = [''];
  while (pending.length > 0) {
    const relFolder = pending.pop();
    let entries;
    try {
      entries = readdirSync(join(root, relFolder), { withFileTypes: true });
    } catch (error) {
      if (relFolder === '') throw error;
      problems.push({ path: relFolder, reason: error.message });
      continue;
    }
    for (const entry of entries) {
      const rel = relFolder === '' ? entry.name : `${relFolder}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) files.push(rel);
      else if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) {
        folders.push(rel);
        pending.push(rel);
      }
    }
  }
  return { files: files.sort(), folders: folders.sort(), problems };
}
