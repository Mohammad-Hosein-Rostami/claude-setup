// Collects everything env-names knows about a project folder, as a plain object that is also the snapshot format.
// Exports: SNAPSHOT_VERSION, collectProject(root, wrappers, now) -> snapshot object.
// Invariants: values never enter this object: env files come through readEnvFile (names only), code and deploy files
//   through scanners that capture names only. Paths are posix relative to root; `file:line` strings are sorted by path.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanCode } from './code-reads.mjs';
import { analyze } from './analyze.mjs';
import { scanDeploy } from './deploy-names.mjs';
import { readEnvFile } from './env-file-names.mjs';
import { walkProject } from './walk.mjs';

export const SNAPSHOT_VERSION = 1;
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

/** The text of a source or deploy file, or null after recording why it was not read. */
function readScanned(root, path, notRead) {
  try {
    if (statSync(join(root, path)).size > MAX_SCANNED_FILE_BYTES) {
      notRead.push({ path, reason: 'too large, not read' });
      return null;
    }
    return readFileSync(join(root, path), 'utf8');
  } catch (err) {
    notRead.push({ path, reason: `unreadable (${err.code ?? 'error'}), not read` });
    return null;
  }
}

function addRef(map, name, ref) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(ref);
}

const toSortedObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * @param {string} root absolute path of an existing folder
 * @param {string[]} wrappers functions whose first string argument is a variable name
 * @param {Date} now stamp for `generatedAt`
 * @returns the snapshot: { version, root, generatedAt, envFiles, readByCode, builtin, dynamic, deploy, notRead, ...analysis }
 */
export function collectProject(root, wrappers, now) {
  const walked = walkProject(root);
  const notRead = [...walked.notRead];
  const readByCode = new Map();
  const builtin = new Map();
  const dynamic = new Map();
  const deploy = new Map();
  for (const { path } of walked.sources) {
    const text = readScanned(root, path, notRead);
    if (text === null) continue;
    const scanned = scanCode(text, wrappers);
    for (const read of scanned.reads) addRef(read.builtin ? builtin : readByCode, read.name, `${path}:${read.line}`);
    if (scanned.dynamic > 0) dynamic.set(path, scanned.dynamic);
  }
  for (const { path, kind } of walked.deploys) {
    const text = readScanned(root, path, notRead);
    if (text !== null) for (const { name, line } of scanDeploy(kind, text)) addRef(deploy, name, `${path}:${line}`);
  }
  const envFiles = walked.envFiles.map(({ path }) => ({ path, ...readEnvFile(join(root, path)) }));
  const data = {
    version: SNAPSHOT_VERSION, root, generatedAt: now.toISOString(), envFiles,
    readByCode: toSortedObject(readByCode), builtin: toSortedObject(builtin), dynamic: toSortedObject(dynamic),
    deploy: toSortedObject(deploy), notRead: notRead.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return { ...data, ...analyze(data) };
}
