// Collects everything env-names knows about a project folder, as a plain object that is also the snapshot format.
// Exports: collectProject(root, wrappers, now) -> snapshot object.
// Invariants: values never enter this object: env files come through readEnvFile (names only), code and deploy files
//   through scanners that capture names only. A name from an env file is kept only when it is a plain name (name-shape.mjs) or
//   code or a deploy file names it too; the others are counted in `hiddenNames`. In an irregular env file (multi-line or unusual
//   values) only names that code or a deploy file names are kept at all. Paths are posix relative to root.
import { join } from 'node:path';
import { scanCode } from './code-reads.mjs';
import { analyze } from './analyze.mjs';
import { scanDeploy } from './deploy-names.mjs';
import { readEnvFile } from './env-file-names.mjs';
import { isPlainName } from './name-shape.mjs';
import { readRegularFile } from './read-regular-file.mjs';
import { SNAPSHOT_VERSION } from './snapshot.mjs';
import { walkProject } from './walk.mjs';

const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

/** The text of a source or deploy file, or null after recording why it was not read. */
function readScanned(root, path, notRead) {
  try {
    const { bytes, skipped } = readRegularFile(join(root, path), MAX_SCANNED_FILE_BYTES);
    if (skipped === undefined) return bytes.toString('utf8');
    notRead.push({ path, reason: `${skipped}, not read` });
    return null;
  } catch (err) {
    notRead.push({ path, reason: `unreadable (${err.code ?? 'error'}), not read` });
    return null;
  }
}

function addRef(map, name, ref) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(ref);
}

/** One env file as it is reported: names that pass the output rule, a count of the rest, or why it was not read. */
function describeEnvFile(root, { path, structured }, namedElsewhere) {
  if (structured) return { path, names: [], otherLines: 0, status: 'not read (structured file)' };
  const read = readEnvFile(join(root, path));
  if (read.status !== undefined) return { path, ...read };
  // An irregular file may hold fragments of multi-line values that look like names: only names other files corroborate are shown.
  const shown = read.names.filter((name) => namedElsewhere.has(name) || (!read.irregular && isPlainName(name)));
  const entry = { path, names: shown, otherLines: read.otherLines, hiddenNames: read.names.length - shown.length };
  return read.irregular ? { ...entry, irregular: true } : entry;
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
    if (text === null) continue;
    const { mentions, hidden } = scanDeploy(kind, text);
    for (const { name, line } of mentions) addRef(deploy, name, `${path}:${line}`);
    if (hidden > 0) notRead.push({ path, reason: `${hidden} names not shown (mixed case or too long)` });
  }
  const namedElsewhere = new Set([...readByCode.keys(), ...builtin.keys(), ...deploy.keys()]);
  const envFiles = walked.envFiles.map((file) => describeEnvFile(root, file, namedElsewhere));
  const data = {
    version: SNAPSHOT_VERSION, root, generatedAt: now.toISOString(), wrappers: [...new Set(wrappers)].sort(), envFiles,
    readByCode: toSortedObject(readByCode), builtin: toSortedObject(builtin), dynamic: toSortedObject(dynamic),
    deploy: toSortedObject(deploy), notRead: notRead.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return { ...data, ...analyze(data) };
}
