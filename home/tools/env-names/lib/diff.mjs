// Compares an old snapshot with the current collection: what moved between two points in time, by name only.
// Exports: diffSnapshots(old, now) -> { since, changed, nowUndefined, movedOutOfChain, notReadNow, envFiles: { added, removed },
//   namesChanged, hiddenChanged, readByCode, deploy }. Names that are not shown are compared by count only.
// Invariants: pure; names, paths and `file:line` references only. Files are matched by path: a moved env file is one removed and
//   one added, and `sameNamesAs` points to the partner when both hold the same (non-empty) set of names. Example files define
//   nothing. An env file that is no longer read (link, binary, unreadable...) is reported as such and its names are never
//   counted as undefined.
import { refsOutsideChain } from './analyze.mjs';
import { isExampleFile } from './walk.mjs';

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

/** Files read before and now, with names added or removed (a file not read on either side is left to `notReadNow`). */
function diffNames(oldFiles, nowFiles) {
  const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
  const changed = [];
  for (const file of nowFiles) {
    const before = oldByPath.get(file.path);
    if (before === undefined || before.status !== undefined || file.status !== undefined || before.irregular !== file.irregular) continue;
    const added = file.names.filter((name) => !before.names.includes(name));
    const removed = before.names.filter((name) => !file.names.includes(name));
    if (added.length > 0 || removed.length > 0) changed.push({ path: file.path, added, removed });
  }
  return changed.sort((a, b) => byText(a.path, b.path));
}

/** Files read before and now whose count of hidden names, or irregular mark, changed: counts only, never the hidden names. */
function diffHidden(oldFiles, nowFiles) {
  const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
  const changed = [];
  for (const file of nowFiles) {
    const before = oldByPath.get(file.path);
    if (before === undefined || before.status !== undefined || file.status !== undefined) continue;
    const row = { path: file.path, from: before.hiddenNames ?? 0, to: file.hiddenNames ?? 0, irregularFrom: before.irregular === true, irregularTo: file.irregular === true };
    if (row.from !== row.to || row.irregularFrom !== row.irregularTo) changed.push(row);
  }
  return changed.sort((a, b) => byText(a.path, b.path));
}

/** Env files that were read before and are not now, with the reason. */
function findNotReadNow(oldFiles, nowFiles) {
  const wasRead = new Set(oldFiles.filter((file) => file.status === undefined).map((file) => file.path));
  return nowFiles.filter((file) => file.status !== undefined && wasRead.has(file.path)).map((file) => ({ path: file.path, reason: file.status }));
}

/** name -> paths of the real (non-example) env files that define it. */
function definersOf(envFiles) {
  const defined = new Map();
  for (const file of envFiles.filter((envFile) => !isExampleFile(envFile.path))) {
    for (const name of file.names) defined.set(name, [...(defined.get(name) ?? []), file.path]);
  }
  return defined;
}

/** Names code reads now: undefined now though defined before, and defined now but no longer in the reader's folder chain. */
function findLostDefinitions(old, now, notReadNow) {
  const before = definersOf(old.envFiles);
  const after = definersOf(now.envFiles);
  const unreadPaths = new Set(notReadNow.map((file) => file.path));
  const namesOfUnread = new Set(old.envFiles.filter((file) => unreadPaths.has(file.path)).flatMap((file) => file.names));
  const nowUndefined = [];
  const movedOutOfChain = [];
  for (const [name, refs] of Object.entries(now.readByCode)) {
    if (!before.has(name) || namesOfUnread.has(name)) continue;
    if (!after.has(name)) {
      nowUndefined.push({ name, firstUse: refs[0], wasIn: before.get(name) });
      continue;
    }
    const outsideNow = refsOutsideChain(refs, after.get(name));
    if (outsideNow.length > 0 && refsOutsideChain(refs, before.get(name)).length === 0) {
      movedOutOfChain.push({ name, firstUse: outsideNow[0], wasIn: before.get(name), nowIn: after.get(name) });
    }
  }
  return { nowUndefined, movedOutOfChain };
}

/**
 * @param {object} old a validated snapshot
 * @param {object} now the current collection (same shape)
 */
export function diffSnapshots(old, now) {
  const notReadNow = findNotReadNow(old.envFiles, now.envFiles);
  const result = {
    since: old.generatedAt,
    ...findLostDefinitions(old, now, notReadNow),
    notReadNow,
    envFiles: diffEnvFiles(old.envFiles, now.envFiles),
    namesChanged: diffNames(old.envFiles, now.envFiles),
    hiddenChanged: diffHidden(old.envFiles, now.envFiles),
    readByCode: diffReferences(old.readByCode, now.readByCode),
    deploy: diffReferences(old.deploy, now.deploy),
  };
  const lists = [result.nowUndefined, result.movedOutOfChain, result.notReadNow, result.envFiles.added, result.envFiles.removed,
    result.namesChanged, result.hiddenChanged, result.readByCode.added, result.readByCode.removed, result.deploy.added, result.deploy.removed];
  return { ...result, changed: lists.some((list) => list.length > 0) };
}
