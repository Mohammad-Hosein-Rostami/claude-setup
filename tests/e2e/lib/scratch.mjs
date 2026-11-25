// The e2e run's scratch root and its safe removal. Exports: RUN_PREFIX, MARKER_FILE, STALE_AFTER_MS, makeRunRoot(tempRoot),
// assertInside(path, root), removeRunRoot(root, madeRoots), removeProjectFolders(projectsDir, root), staleRoots(tempRoot, nowMs),
// removeStaleRoots(tempRoot, nowMs).
// Why: every throwaway repo, the child HOME and long-run's state live under one `<temp>/cs-test-e2e-<stamp>-XXXXXX/` root
// (`cs-test-` is the prefix the guard and disk-clean already treat as test scratch, temp-dir-helpers.mjs), so one removal ends
// the run and nothing else can be hit.
// Invariants: a root is removed only when this process made it (the `madeRoots` set), its real path is the one recorded, its name
// starts with RUN_PREFIX and its marker file names this user; a project folder (real-HOME mode) only when its name is the project
// key of a folder inside the root and it is a direct child of the projects folder; a stale root (a killed run) only with a marker
// of this user older than STALE_AFTER_MS. Anything else is refused with a reason, never removed.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { TEST_TEMP_PREFIX, testTempRoot } from '../../temp-dir-helpers.mjs';
import { projectKey } from './transcripts.mjs';

export const RUN_PREFIX = `${TEST_TEMP_PREFIX}e2e-`;
export const MARKER_FILE = '.cs-e2e-run.json';
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // plan section 10: a killed run's root is removed by the next run after a day
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * @param {string} tempRoot where to make it (default: testTempRoot(), outside Claude Code's own temp tree)
 * @returns {string} the new root's real path, with its marker written
 */
export function makeRunRoot(tempRoot = testTempRoot()) {
  const root = realpathSync(mkdtempSync(join(tempRoot, `${RUN_PREFIX}${stampOf(new Date())}-`)));
  writeFileSync(join(root, MARKER_FILE), JSON.stringify({ uid: uid(), pid: process.pid, createdAt: new Date().toISOString() }));
  return root;
}

const realOrNull = (path) => { try { return realpathSync(path); } catch { return null; } };
const markerOf = (root) => { try { return JSON.parse(readFileSync(join(root, MARKER_FILE), 'utf8')); } catch { return null; } };

/**
 * @param {string} path a path the run is about to write or remove
 * @param {string} root the run root
 * @returns {string} the path's real path
 * @throws {Error} when the path is not inside the root (after following links)
 */
export function assertInside(path, root) {
  const real = realOrNull(path) ?? join(realOrNull(dirname(path)) ?? dirname(path), basename(path));
  const top = realOrNull(root) ?? root;
  if (real !== top && !real.startsWith(`${top}${sep}`)) throw new Error(`e2e: refused: ${path} is outside the run root ${root}`);
  return real;
}

/**
 * @param {string} root the run root
 * @param {Set<string>} madeRoots the roots this process made
 * @returns {{removed: boolean, reason: string}}
 */
export function removeRunRoot(root, madeRoots) {
  const real = realOrNull(root);
  if (real === null) return { removed: false, reason: `${root} does not exist` };
  if (!madeRoots.has(real)) return { removed: false, reason: `refused: ${root} was not made by this run` };
  if (!basename(real).startsWith(RUN_PREFIX)) return { removed: false, reason: `refused: ${root} does not start with ${RUN_PREFIX}` };
  if (lstatSync(root).isSymbolicLink()) return { removed: false, reason: `refused: ${root} is a link` };
  const marker = markerOf(real);
  if (marker === null || marker.uid !== uid()) return { removed: false, reason: `refused: ${root} has no marker of this user` };
  rmSync(real, { recursive: true, force: true });
  return { removed: true, reason: 'removed' };
}

/**
 * Real-HOME mode: the project folders Claude Code made for folders inside the root (their key starts with the root's key).
 * @param {string} projectsDir `~/.claude/projects`
 * @param {string} root the run root
 * @returns {{removed: string[], refused: string[]}}
 */
export function removeProjectFolders(projectsDir, root) {
  const rootKey = projectKey(root);
  const removed = [];
  const refused = [];
  if (!basename(root).startsWith(RUN_PREFIX)) return { removed, refused: [`${root} does not start with ${RUN_PREFIX}`] };
  let names = [];
  try { names = readdirSync(projectsDir); } catch { return { removed, refused }; }
  for (const name of names.filter((one) => one === rootKey || one.startsWith(`${rootKey}-`))) {
    const folder = join(projectsDir, name);
    const real = realOrNull(folder);
    if (real === null || dirname(real) !== realOrNull(projectsDir) || lstatSync(folder).isSymbolicLink()) {
      refused.push(folder);
      continue;
    }
    rmSync(real, { recursive: true, force: true });
    removed.push(folder);
  }
  return { removed, refused };
}

/** @returns {string[]} roots of earlier runs of this user, older than STALE_AFTER_MS (a killed runner leaves its root) */
export function staleRoots(tempRoot = testTempRoot(), nowMs = Date.now()) {
  let names = [];
  try { names = readdirSync(tempRoot); } catch { return []; }
  return names.filter((name) => name.startsWith(RUN_PREFIX)).map((name) => join(tempRoot, name)).filter((root) => {
    const marker = markerOf(root);
    const made = Date.parse(marker?.createdAt ?? '');
    return marker?.uid === uid() && Number.isFinite(made) && nowMs - made > STALE_AFTER_MS && !lstatSync(root).isSymbolicLink();
  });
}

/** Removes the stale roots of this user. @returns {string[]} the roots removed */
export function removeStaleRoots(tempRoot = testTempRoot(), nowMs = Date.now()) {
  const stale = staleRoots(tempRoot, nowMs);
  for (const root of stale) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  return stale;
}
