// Lists the files env-names looks at: env files, source files and deploy files, at any depth, hidden folders included.
// Exports: SKIPPED_FOLDERS, isEnvFileName(name), walkProject(root) -> { envFiles, sources, deploys, notRead }.
// Invariants: nothing is read here, only names are listed. Git is not asked, so untracked and git-ignored files count.
//   Symlinks are never followed: a linked folder is not entered, a linked source file is skipped, a linked env file is
//   listed (the reader reports it as `link, not read`). All paths are posix, relative to root, sorted.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_FILE_PATTERN } from './code-reads.mjs';
import { deployKind } from './deploy-names.mjs';
import { UsageError } from './usage-error.mjs';

export const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.nx', '.next', '.turbo', '.cache']);

/** `.env`, `.env.*` and `*.env`. */
export const isEnvFileName = (name) => name === '.env' || name.startsWith('.env.') || name.endsWith('.env');

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function visit(root, folder, found) {
  let entries;
  try {
    entries = readdirSync(join(root, folder), { withFileTypes: true });
  } catch (err) {
    if (folder === '') throw new UsageError(`cannot read folder ${root} (${err.code ?? 'error'})`);
    found.notRead.push({ path: folder, reason: `unreadable folder (${err.code ?? 'error'})` });
    return;
  }
  for (const entry of entries.sort(byName)) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) visit(root, path, found);
    } else if (isEnvFileName(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
      found.envFiles.push({ path });
    } else if (entry.isFile() && deployKind(path) !== null) {
      found.deploys.push({ path, kind: deployKind(path) });
    } else if (entry.isFile() && CODE_FILE_PATTERN.test(entry.name)) {
      found.sources.push({ path });
    }
  }
}

/**
 * @param {string} root absolute path of an existing folder
 * @returns {{ envFiles: {path}[], sources: {path}[], deploys: {path, kind}[], notRead: {path, reason}[] }}
 */
export function walkProject(root) {
  const found = { envFiles: [], sources: [], deploys: [], notRead: [] };
  visit(root, '', found);
  for (const list of Object.values(found)) list.sort(byPath);
  return found;
}
