// The three questions env-names answers from the collected facts: what code reads that no env file defines, what an env
// file defines that nothing reads, and where env files of one folder disagree.
// Exports: analyze(data) -> { undefinedNames, neverRead, differing, summary }.
// Invariants: pure; works on names and paths only. Maps and Sets are used for lookups so a variable called `constructor`
//   or `__proto__` is just a name.
import { dirname } from 'node:path/posix';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedBy = (items, key) => items.sort((a, b) => byText(key(a), key(b)));

/** name -> paths of the env files that define it (files that were not read define nothing). */
function definitions(envFiles) {
  const defined = new Map();
  for (const file of envFiles) {
    for (const name of file.names) defined.set(name, [...(defined.get(name) ?? []), file.path]);
  }
  return defined;
}

/** Per folder with 2 or more read env files: every name that some of them have and others lack. */
function differences(envFiles) {
  const folders = new Map();
  for (const file of envFiles.filter((envFile) => envFile.status === undefined)) {
    const folder = dirname(file.path);
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  const differing = [];
  for (const files of [...folders.values()].filter((group) => group.length > 1)) {
    const union = new Set(files.flatMap((file) => file.names));
    for (const name of union) {
      const has = files.filter((file) => file.names.includes(name)).map((file) => file.path);
      if (has.length < files.length) differing.push({ name, has, lacks: files.map((file) => file.path).filter((path) => !has.includes(path)) });
    }
  }
  return sortedBy(differing, (entry) => `${entry.has[0]} ${entry.name}`);
}

/**
 * @param {{ envFiles, readByCode, builtin, deploy }} data the collected facts
 * @returns {{ undefinedNames: {name, firstUse}[], neverRead: {name, files}[], differing: {name, has, lacks}[], summary }}
 */
export function analyze({ envFiles, readByCode, builtin, deploy }) {
  const defined = definitions(envFiles);
  const used = new Set([...Object.keys(readByCode), ...Object.keys(builtin), ...Object.keys(deploy)]);
  const undefinedNames = Object.entries(readByCode).filter(([name]) => !defined.has(name)).map(([name, refs]) => ({ name, firstUse: refs[0] }));
  const neverRead = [...defined].filter(([name]) => !used.has(name)).map(([name, files]) => ({ name, files }));
  return {
    undefinedNames,
    neverRead: sortedBy(neverRead, (entry) => entry.name),
    differing: differences(envFiles),
    summary: { envFiles: envFiles.length, definedNames: defined.size, readNames: Object.keys(readByCode).length },
  };
}
