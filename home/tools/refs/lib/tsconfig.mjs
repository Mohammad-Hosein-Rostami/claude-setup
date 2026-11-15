// Purpose: readers for tsconfig*.json and jsconfig*.json: extends, references, paths aliases, literal include/files.
// Exports: readTsconfig.
// Invariants: a target with `*` is checked up to the wildcard; an `extends` that names a package is skipped; `include`
//   and `files` entries with glob characters are skipped. Alias targets without an extension also match a file with a
//   TypeScript or JavaScript extension, like the compiler resolves them.
import { dirname } from 'node:path';
import { objectGet, parseJsonc, stringLeaves } from './jsonc.mjs';
import { folderBeforeWildcard, hasGlobChars, resolveRef } from './ref-path.mjs';

const CODE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const isPackageName = (value) => !value.startsWith('.') && !value.startsWith('/');

function extendsFindings(root, folder, disk) {
  return stringLeaves(objectGet(root, 'extends'))
    .filter((leaf) => !isPackageName(leaf.value))
    .filter((leaf) => !disk.exists(resolveRef(folder, leaf.value)) && !disk.exists(`${resolveRef(folder, leaf.value)}.json`))
    .map((leaf) => ({ kind: 'tsconfig-extends', value: leaf.value, line: leaf.line }));
}

function referenceFindings(root, folder, disk) {
  const references = objectGet(root, 'references');
  const paths = (references?.items ?? []).map((item) => objectGet(item, 'path')).filter((node) => node?.kind === 'string');
  return paths
    .filter((node) => !disk.exists(resolveRef(folder, node.value)))
    .map((node) => ({ kind: 'tsconfig-reference', value: node.value, line: node.line }));
}

function aliasTargetExists(base, target, disk) {
  if (target.includes('*')) return disk.exists(resolveRef(base, folderBeforeWildcard(target) || '.'));
  const path = resolveRef(base, target);
  return disk.exists(path) || CODE_EXTENSIONS.some((extension) => disk.exists(path + extension));
}

function pathFindings(root, folder, disk) {
  const options = objectGet(root, 'compilerOptions');
  const baseUrl = objectGet(options, 'baseUrl');
  const base = baseUrl?.kind === 'string' ? resolveRef(folder, baseUrl.value) : folder;
  const aliases = objectGet(options, 'paths')?.entries ?? [];
  return aliases
    .flatMap((alias) => stringLeaves(alias.node))
    .filter((target) => !aliasTargetExists(base, target.value, disk))
    .map((target) => ({ kind: 'tsconfig-path', value: target.value, line: target.line }));
}

function includeFindings(root, folder, disk) {
  return ['include', 'files']
    .flatMap((key) => stringLeaves(objectGet(root, key)))
    .filter((entry) => !hasGlobChars(entry.value) && !disk.exists(resolveRef(folder, entry.value)))
    .map((entry) => ({ kind: 'tsconfig-include', value: entry.value, line: entry.line }));
}

/**
 * Findings of one tsconfig/jsconfig file.
 * @param {{abs: string, text: string}} file the file and its content
 * @param {{disk: import('./disk.mjs').Disk}} context
 * @returns {{kind: string, value: string, line: number}[]}
 * @throws {import('./jsonc.mjs').JsonSyntaxError} when the file is not JSON with comments
 */
export function readTsconfig(file, { disk }) {
  const root = parseJsonc(file.text);
  const folder = dirname(file.abs);
  return [extendsFindings, referenceFindings, pathFindings, includeFindings].flatMap((reader) => reader(root, folder, disk));
}
