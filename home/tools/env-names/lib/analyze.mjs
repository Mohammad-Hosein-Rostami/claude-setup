// The questions env-names answers from the collected facts: what code reads that no env file defines, what code reads that is
// defined only outside its own folder chain, what an env file defines that nothing reads, and where env files of one folder
// disagree.
// Exports: analyze(data) -> { undefinedNames, outsideChain, neverRead, differing, summary }; refsOutsideChain(refs, envPaths).
// Invariants: pure; works on names and paths only. Example files (`.env.example` and the like) document names, they never
//   define one. A read in file F is defined by an env file in F's folder or any parent folder (the folder chain). Maps and
//   Sets are used for lookups so a variable called `constructor` or `__proto__` is just a name.
import { dirname } from 'node:path/posix';
import { isExampleFile } from './walk.mjs';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedBy = (items, key) => items.sort((a, b) => byText(key(a), key(b)));
const fileOfRef = (ref) => ref.slice(0, ref.lastIndexOf(':'));

/** True when the env file at `envPath` sits in the folder of `filePath` or one of its parents. */
function inFolderChain(envPath, filePath) {
  const envFolder = dirname(envPath);
  const fileFolder = dirname(filePath);
  return envFolder === '.' || fileFolder === envFolder || fileFolder.startsWith(`${envFolder}/`);
}

/** The `file:line` references that no env file of `envPaths` covers through the folder chain. */
export function refsOutsideChain(refs, envPaths) {
  return refs.filter((ref) => !envPaths.some((envPath) => inFolderChain(envPath, fileOfRef(ref))));
}

/** name -> paths of the env files that define it; example files and files that were not read define nothing. */
function definitions(envFiles) {
  const defined = new Map();
  for (const file of envFiles.filter((envFile) => !isExampleFile(envFile.path))) {
    for (const name of file.names) defined.set(name, [...(defined.get(name) ?? []), file.path]);
  }
  return defined;
}

/** Per folder with 2 or more read env files (examples included): every name that some of them have and others lack. */
function differences(envFiles) {
  const folders = new Map();
  for (const file of envFiles.filter((envFile) => envFile.status === undefined)) {
    const folder = dirname(file.path);
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  const differing = [];
  for (const files of [...folders.values()].filter((group) => group.length > 1)) {
    for (const name of new Set(files.flatMap((file) => file.names))) {
      const has = files.filter((file) => file.names.includes(name)).map((file) => file.path);
      if (has.length < files.length) differing.push({ name, has, lacks: files.map((file) => file.path).filter((path) => !has.includes(path)) });
    }
  }
  return sortedBy(differing, (entry) => `${entry.has[0]} ${entry.name}`);
}

/** Names read by code that no env file defines (with the example files that name them) or only outside the reader's chain. */
function readButNotDefined(envFiles, readByCode, defined) {
  const examples = envFiles.filter((file) => isExampleFile(file.path));
  const undefinedNames = [];
  const outsideChain = [];
  for (const [name, refs] of Object.entries(readByCode)) {
    if (!defined.has(name)) {
      undefinedNames.push({ name, firstUse: refs[0], inExample: examples.filter((file) => file.names.includes(name)).map((file) => file.path) });
      continue;
    }
    const outside = refsOutsideChain(refs, defined.get(name));
    if (outside.length > 0) outsideChain.push({ name, firstUse: outside[0], definedIn: defined.get(name) });
  }
  return { undefinedNames, outsideChain };
}

/**
 * @param {{ envFiles, readByCode, builtin, deploy }} data the collected facts
 * @returns {{ undefinedNames, outsideChain, neverRead, differing, summary }}
 */
export function analyze({ envFiles, readByCode, builtin, deploy }) {
  const defined = definitions(envFiles);
  const used = new Set([...Object.keys(readByCode), ...Object.keys(builtin), ...Object.keys(deploy)]);
  const neverRead = [...defined].filter(([name]) => !used.has(name)).map(([name, files]) => ({ name, files }));
  return {
    ...readButNotDefined(envFiles, readByCode, defined),
    neverRead: sortedBy(neverRead, (entry) => entry.name),
    differing: differences(envFiles),
    summary: {
      envFiles: envFiles.filter((file) => !isExampleFile(file.path)).length,
      exampleFiles: envFiles.filter((file) => isExampleFile(file.path)).length,
      definedNames: defined.size,
      readNames: Object.keys(readByCode).length,
    },
  };
}
