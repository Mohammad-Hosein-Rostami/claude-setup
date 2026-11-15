// Purpose: readers for tsconfig*.json and jsconfig*.json: extends, references, paths aliases, literal include/files.
// Exports: readTsconfig.
// Invariants: a target with `*` is checked up to the wildcard; an `extends` that names a package is skipped; `include`
//   and `files` entries with glob characters are skipped. Alias targets resolve against the `baseUrl` found through the
//   `extends` chain (relative parents only), else against the folder of the file that defines `paths`. When the chain
//   cannot be followed (a package parent, a missing or unreadable parent) no alias is judged: one hint
//   `tsconfig-path?` says why, because a finding must be certain.
import { dirname } from 'node:path';
import { objectGet, parseJsonc, stringLeaves } from './jsonc.mjs';
import { codePathExists, folderBeforeWildcard, hasGlobChars, resolveRef } from './ref-path.mjs';

const MAX_EXTENDS_DEPTH = 20; // also stops an extends cycle
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

/** Reads a parent config named by a relative `extends` value: {root, folder}, or {why} when it cannot be followed. */
function readParent(value, folder, disk) {
  if (isPackageName(value)) return { why: `extends "${value}" names a package` };
  const base = resolveRef(folder, value);
  for (const path of [base, `${base}.json`]) {
    if (!disk.exists(path)) continue;
    try {
      return { root: parseJsonc(disk.readText(path)), folder: dirname(path) };
    } catch {
      // a folder or an unparsable file: try the next spelling
    }
  }
  return { why: `extends "${value}" cannot be read` };
}

/** The folder baseUrl points to, looking through `extends`: {dir} (dir is null when nobody sets one) or {why}. */
function findBaseUrl(root, folder, disk, depth = 0) {
  const own = objectGet(objectGet(root, 'compilerOptions'), 'baseUrl');
  if (own?.kind === 'string') return { dir: resolveRef(folder, own.value) };
  if (depth > MAX_EXTENDS_DEPTH) return { why: 'the extends chain is too deep' };
  for (const parent of stringLeaves(objectGet(root, 'extends')).reverse()) { // the last entry of an array wins
    const read = readParent(parent.value, folder, disk);
    if (read.why !== undefined) return { why: read.why };
    const found = findBaseUrl(read.root, read.folder, disk, depth + 1);
    if (found.why !== undefined || found.dir !== null) return found;
  }
  return { dir: null };
}

function aliasTargetExists(base, target, disk) {
  if (target.includes('*')) return disk.exists(resolveRef(base, folderBeforeWildcard(target) || '.'));
  return codePathExists(disk, resolveRef(base, target));
}

function pathFindings(root, folder, disk) {
  const paths = objectGet(objectGet(root, 'compilerOptions'), 'paths');
  if (paths === undefined) return [];
  const found = findBaseUrl(root, folder, disk);
  if (found.why !== undefined) return [{ kind: 'tsconfig-path?', value: `paths not checked: ${found.why}`, line: paths.line }];
  return paths.entries
    .flatMap((alias) => stringLeaves(alias.node))
    .filter((target) => !aliasTargetExists(found.dir ?? folder, target.value, disk))
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
