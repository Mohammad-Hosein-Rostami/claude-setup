// Purpose: list the files and folders of the scanned directory, hidden folders (.github, .cursor, .claude) included.
// Exports: SKIPPED_FOLDERS, NEVER_ENTER, walkTree.
// Invariants: symlinks are never followed and never listed, so a loop or a link out of the directory cannot be entered.
//   Returns posix paths relative to root, sorted. A folder that cannot be read becomes a problem, never an exception;
//   only the root itself throws. Skipped folders are listed in `folders` but their content is not.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.nx', '.next', '.turbo', '.cache']);
/** The only folders no existence question is ever answered from: a name there is not a project path. */
export const NEVER_ENTER = new Set(['.git', 'node_modules']);

/**
 * @param {string} root folder to walk
 * @param {Set<string>} [skipped] folder names that are listed but not entered
 * @returns {{files: string[], folders: string[], problems: {path: string, reason: string}[]}}
 * @throws when the root cannot be read
 */
export function walkTree(root, skipped = SKIPPED_FOLDERS) {
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
      // a Dirent for a symlink is neither a file nor a directory, so links fall through both branches and are never followed
      if (entry.isFile()) files.push(rel);
      else if (entry.isDirectory()) {
        folders.push(rel);
        if (!skipped.has(entry.name)) pending.push(rel);
      }
    }
  }
  return { files: files.sort(), folders: folders.sort(), problems };
}
