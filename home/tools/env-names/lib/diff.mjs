// Compares an old snapshot with the current collection: what moved between two points in time, by name only.
// Exports: diffSnapshots(old, now) -> { since, changed, nowUndefined, envFiles: { added, removed }, namesChanged, readByCode, deploy }.
// Invariants: pure; names, paths and `file:line` references only. Files are matched by path: a moved env file is one
//   removed and one added, and `sameNamesAs` points to the partner when both hold the same (non-empty) set of names.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Names in `next` that `previous` lacks, each with the references `next` has for it; both are name -> refs objects. */
function onlyIn(next, previous) {
  const known = new Set(Object.keys(previous));
  return Object.entries(next).filter(([name]) => !known.has(name)).map(([name, refs]) => ({ name, refs }));
}

const diffReferences = (old, now) => ({ added: onlyIn(now, old), removed: onlyIn(old, now) });

const nameSetKey = (file) => (file.names.length === 0 ? null : file.names.join(','));

/** Env files added or removed; each lists the other file that holds exactly the same names, when there is one. */
function diffEnvFiles(oldFiles, nowFiles) {
  const oldPaths = new Set(oldFiles.map((file) => file.path));
  const nowPaths = new Set(nowFiles.map((file) => file.path));
  const removed = oldFiles.filter((file) => !nowPaths.has(file.path));
  const added = nowFiles.filter((file) => !oldPaths.has(file.path));
  const partner = (file, candidates) => {
    const key = nameSetKey(file);
    return key === null ? undefined : candidates.find((other) => nameSetKey(other) === key)?.path;
  };
  const describe = (file, candidates) => ({ path: file.path, sameNamesAs: partner(file, candidates) });
  return { added: added.map((file) => describe(file, removed)), removed: removed.map((file) => describe(file, added)) };
}

function diffNames(oldFiles, nowFiles) {
  const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
  const changed = [];
  for (const file of nowFiles) {
    const before = oldByPath.get(file.path);
    if (before === undefined) continue;
    const added = file.names.filter((name) => !before.names.includes(name));
    const removed = before.names.filter((name) => !file.names.includes(name));
    if (added.length > 0 || removed.length > 0) changed.push({ path: file.path, added, removed });
  }
  return changed.sort((a, b) => byText(a.path, b.path));
}

/** Names code reads now that an env file defined before and no env file defines now. */
function findNowUndefined(old, now) {
  const definedNow = new Set(now.envFiles.flatMap((file) => file.names));
  return Object.entries(now.readByCode).flatMap(([name, refs]) => {
    const wasIn = old.envFiles.filter((file) => file.names.includes(name)).map((file) => file.path);
    return definedNow.has(name) || wasIn.length === 0 ? [] : [{ name, firstUse: refs[0], wasIn }];
  });
}

/**
 * @param {object} old a validated snapshot
 * @param {object} now the current collection (same shape)
 */
export function diffSnapshots(old, now) {
  const result = {
    since: old.generatedAt,
    nowUndefined: findNowUndefined(old, now),
    envFiles: diffEnvFiles(old.envFiles, now.envFiles),
    namesChanged: diffNames(old.envFiles, now.envFiles),
    readByCode: diffReferences(old.readByCode, now.readByCode),
    deploy: diffReferences(old.deploy, now.deploy),
  };
  const lists = [result.nowUndefined, result.envFiles.added, result.envFiles.removed, result.namesChanged,
    result.readByCode.added, result.readByCode.removed, result.deploy.added, result.deploy.removed];
  return { ...result, changed: lists.some((list) => list.length > 0) };
}
