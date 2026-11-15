// Purpose: readers for package.json (entry points, workspaces) and pnpm-workspace.yaml (workspace patterns).
// Exports: readPackageJson, readPnpmWorkspace.
// Invariants: package entries are resolved from the folder of the package.json; one that is missing under a build output
//   folder (dist, build, lib, out) is only a hint `package-entry?`, because the build creates it. A `*` in an entry is
//   checked up to the wildcard. Workspace entries must match a folder; negated entries (`!...`) are skipped.
import { dirname } from 'node:path';
import { globMatches } from './glob.mjs';
import { objectGet, parseJsonc, stringLeaves } from './jsonc.mjs';
import { folderBeforeWildcard, resolveRef } from './ref-path.mjs';
import { scanYaml } from './yaml-lines.mjs';

const BUILD_OUTPUT_FOLDERS = new Set(['dist', 'build', 'lib', 'out']);
const MODULE_FIELDS = new Set(['main', 'module', 'types', 'typings']);
const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.json'];
const ENTRY_FIELDS = ['main', 'module', 'types', 'typings', 'bin', 'exports'];

const entryExists = (folder, value, disk) => disk.exists(resolveRef(folder, value.includes('*') ? folderBeforeWildcard(value) || '.' : value));

function entryKind(value) {
  const first = value.replaceAll('\\', '/').replace(/^\.\//, '').split('/')[0];
  return BUILD_OUTPUT_FOLDERS.has(first) ? 'package-entry?' : 'package-entry';
}

/** `main: "src/index"` is valid: Node and TypeScript add an extension or look for index.* in a folder. */
function moduleEntryExists(folder, value, disk) {
  const path = resolveRef(folder, value);
  return [path, ...MODULE_EXTENSIONS.flatMap((extension) => [path + extension, `${path}/index${extension}`])].some((candidate) => disk.exists(candidate));
}

function entryResults(root, folder, disk) {
  const exists = (field) => (MODULE_FIELDS.has(field) ? moduleEntryExists : entryExists);
  return ENTRY_FIELDS.flatMap((field) => stringLeaves(objectGet(root, field)).map((leaf) => ({ field, leaf })))
    .filter(({ field, leaf }) => !exists(field)(folder, leaf.value, disk))
    .map(({ leaf }) => leaf)
    .map((leaf) => ({ kind: entryKind(leaf.value), value: leaf.value, line: leaf.line }));
}

function workspaceResults(root, folder, disk) {
  const workspaces = objectGet(root, 'workspaces');
  const patterns = workspaces?.kind === 'object' ? objectGet(workspaces, 'packages') : workspaces;
  return stringLeaves(patterns)
    .filter((leaf) => !leaf.value.startsWith('!') && !globMatches(disk, folder, leaf.value, { dirsOnly: true }))
    .map((leaf) => ({ kind: 'workspace-glob', value: leaf.value, line: leaf.line }));
}

/**
 * Entry-point and workspace findings of a package.json.
 * @param {{abs: string, text: string}} file
 * @param {{disk: import('./disk.mjs').Disk}} context
 * @throws {import('./jsonc.mjs').JsonSyntaxError} when the file is not JSON
 */
export function readPackageJson(file, { disk }) {
  const root = parseJsonc(file.text);
  const folder = dirname(file.abs);
  return [...entryResults(root, folder, disk), ...workspaceResults(root, folder, disk)];
}

/** Workspace findings of a pnpm-workspace.yaml: `packages` entries that match no folder. */
export function readPnpmWorkspace(file, { disk }) {
  const folder = dirname(file.abs);
  return scanYaml(file.text)
    .filter((entry) => entry.isItem && entry.key === null && entry.value !== null && entry.parents.join('/') === 'packages')
    .filter((entry) => !entry.value.startsWith('!') && !globMatches(disk, folder, entry.value, { dirsOnly: true }))
    .map((entry) => ({ kind: 'workspace-glob', value: entry.value, line: entry.line }));
}
