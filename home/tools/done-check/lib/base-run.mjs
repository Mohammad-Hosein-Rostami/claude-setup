// The base side of the done-check's base compare (design section 3.3 and 6): the base commit's files in a temp folder, so a failing test or
// typecheck can be run there to find out which failures are old, and the cache of those old failures.
// Exports: baseTree(top, base, {deadlineMs}) -> Promise<{dir, cleanup} | {unavailable}>, cachedBase(repoId, base, label) -> Promise<Set | null>,
//   saveBase(repoId, base, label, ids) -> Promise<boolean>.
// How the tree is made: `git read-tree <base>` into a temp index (GIT_INDEX_FILE) and `git checkout-index -a --prefix=<dir>/`, so the real index,
//   worktree list and HEAD never change and no `.git` is written. Each real node_modules folder of the worktree (at the root and next to a package.json
//   of the base tree) is shadowed by a folder of links to the same targets, except a link into the worktree's own packages, which points at the base copy
//   (a package that is new in the head is left out); files inside node_modules are skipped (U6: junctions on Windows, probed on the PC).
// The cache: ~/.claude/state/done-check/base/<sha256 of repo, base and label>.json through lib/session-store.mjs (lstat-checked folder and file,
//   0600, written by rename so a reader sees the old or the new file, never half; old files go after 7 days). Both ends use MAX_CACHE_BYTES. A
//   link at the state folder, the base folder or the file is never followed.
// Invariants: unavailable (a non-empty reason) for a folder that is not a git worktree, a repo or user config that names a filter program (git would
//   run it on checkout-index; wider than gated-folder's namesFilterProgram, which only sees repository config), a commit git does not have, a failed
//   shadow, the deadline, or any error: the caller then says the failures "may be older than your change". The temp folder
//   (`done-check-base-<pid>-<random>/`, made by mkdtemp so a planted name or link is refused) holds the tree and its index and is removed on cleanup,
//   on every failure, and at process exit; a folder of a dead process (never a live one) is removed by the next run. Nothing here throws except
//   a bad argument type is answered as unavailable, null or false.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gitOut, worktreeOf } from '../../../hooks/lib/gated-folder.mjs';
import { isPrivateFile, privateFolder, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { BASE_DEADLINE_MS } from './contract.mjs';

const TEMP_PREFIX = 'done-check-base-';
const TEMP_NAME = /^done-check-base-(\d+)-[A-Za-z0-9]{6}$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONFIG_TIMEOUT_MS = 5000;
const MAX_STDERR_CHARS = 300;
const MAX_CACHE_BYTES = 8 * 1024 * 1024; // the writer refuses more and the reader refuses more: one number for both
const CACHE_VERSION = 1;
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
// same hardening as gated-folder's runGit (which cannot take GIT_INDEX_FILE): no program the repository names runs
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', `core.hooksPath=${devNull}`, '-c', 'log.showSignature=false'];

const liveRoots = new Set();
let exitHookSet = false;

/** Runs git with `indexFile` as its index, without a shell and without waiting past `timeoutMs`; resolves {ok, why}. */
function runIndexGit(cwd, indexFile, args, timeoutMs) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_INDEX_FILE: indexFile };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return new Promise((resolve) => {
    const child = spawn('git', [...HARDENED, ...args], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
    let stderr = '';
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_STDERR_CHARS) stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, why: error.message }));
    child.on('close', (code, signal) => resolve(code === 0 ? { ok: true } : { ok: false, why: signal ? `git ended by ${signal} (deadline)` : stderr.trim().slice(0, MAX_STDERR_CHARS) }));
  });
}

/** True when any config of the repository or the user names a filter program, or the config cannot be read. */
function namesFilter(top) {
  const list = gitOut(top, ['config', '--list', '--name-only'], CONFIG_TIMEOUT_MS);
  return list === null || list.split('\n').some((key) => key.toLowerCase().startsWith('filter.'));
}

function removeFolder(path) {
  liveRoots.delete(path);
  try {
    rmSync(path, { recursive: true, force: true }); // links inside are removed, never followed
  } catch (error) {
    console.error(`done-check base-run: could not remove ${path}: ${error.message}`); // a leftover must be seen; the next run removes it
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // another user's process is alive; only ESRCH says gone
  }
}

/** Removes `done-check-base-<pid>-*` folders in the temp folder whose process is gone. A live process's folder, a link or a file stays. */
function removeDeadLeftovers() {
  try {
    for (const name of readdirSync(tmpdir())) {
      const pid = Number(TEMP_NAME.exec(name)?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) continue;
      const path = join(tmpdir(), name);
      if (lstatSync(path).isDirectory()) removeFolder(path);
    }
  } catch {
    // best effort: an unreadable temp folder or a folder that vanished leaves the work for the next run
  }
}

/** Makes this run's temp folder and arranges its removal at process exit. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  liveRoots.add(root);
  if (!exitHookSet) {
    exitHookSet = true;
    process.once('exit', () => { for (const path of [...liveRoots]) removeFolder(path); });
  }
  return root;
}

/** The tree's root and every folder of `treeDir` that holds a package.json (node_modules and .git left out), absolute. */
function packageFolders(treeDir, stop) {
  const found = [treeDir];
  const pending = [treeDir];
  while (pending.length > 0 && !stop()) {
    const dir = pending.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    if (dir !== treeDir && entries.some((entry) => entry.name === 'package.json' && entry.isFile())) found.push(dir);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') pending.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Where a link target goes in the shadow: the base copy for the worktree's own package (null when the base has none), else the target. */
function shadowTarget(target, { top, treeDir }) {
  const inside = relative(top, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('node_modules')) return target;
  const baseCopy = join(treeDir, inside);
  return existsSync(baseCopy) ? baseCopy : null;
}

/** A folder of links to the entries of `from` (a node_modules folder or a @scope folder inside it). */
function shadowFolder(from, to, context) {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      shadowFolder(source, join(to, entry.name), context);
    } else if (entry.isSymbolicLink() || entry.isDirectory()) {
      const target = shadowTarget(entry.isSymbolicLink() ? realpathSync.native(source) : source, context);
      if (target !== null) symlinkSync(target, join(to, entry.name), 'junction'); // 'junction' is only used on Windows, which needs it
    }
  }
}

/** Shadows the node_modules next to each package.json of the base tree; returns a reason when the deadline passed, else null. */
function shadowNodeModules(top, treeDir, deadlineAt) {
  const context = { top: realpathSync.native(top), treeDir: realpathSync.native(treeDir) };
  const late = () => Date.now() > deadlineAt;
  for (const folder of packageFolders(treeDir, late)) {
    const real = join(top, relative(treeDir, folder), 'node_modules');
    if (lstatSync(real, { throwIfNoEntry: false })?.isDirectory()) shadowFolder(real, join(folder, 'node_modules'), context);
  }
  return late() ? 'the deadline passed while the node_modules links were made' : null;
}

/** Writes the base files and the shadow into `root`; returns the tree folder, or a reason it is unavailable. */
async function fillTree(top, base, root, deadlineAt) {
  const treeDir = join(root, 'tree');
  const indexFile = join(root, 'index');
  mkdirSync(treeDir);
  const steps = [['read-tree', base], ['checkout-index', '-a', `--prefix=${treeDir.split(sep).join('/')}/`]];
  for (const args of steps) {
    const left = deadlineAt - Date.now();
    if (left <= 0) return { unavailable: 'the deadline passed before the base tree was written' };
    const result = await runIndexGit(top, indexFile, args, left);
    if (!result.ok) return { unavailable: `git ${args[0]} failed: ${result.why || 'no message'}` };
  }
  const late = shadowNodeModules(top, treeDir, deadlineAt);
  return late === null ? { treeDir } : { unavailable: late };
}

/**
 * The files of the base commit in a temp folder of their own, with the worktree's node_modules shadowed (see the header).
 * @param {string} top the worktree (any folder inside it)
 * @param {string} base the base commit (full hex id)
 * @param {{deadlineMs?: number}} [options] the most this takes in total (default BASE_DEADLINE_MS)
 * @returns {Promise<{dir: string, cleanup: () => void} | {unavailable: string}>} `cleanup()` removes the tree (twice is harmless); the
 *   caller runs it when it is done. `unavailable` is a non-empty reason and nothing is left on disk then.
 */
export async function baseTree(top, base, { deadlineMs = BASE_DEADLINE_MS } = {}) {
  const deadlineAt = Date.now() + deadlineMs;
  if (typeof top !== 'string' || typeof base !== 'string' || !COMMIT_ID.test(base)) return { unavailable: 'the base commit id is not a full hex id' };
  const tree = worktreeOf(top);
  if (tree === null) return { unavailable: 'the folder is not a git worktree' };
  if (namesFilter(tree.top)) return { unavailable: 'the repository names a filter program (for example LFS), which git would run' };
  removeDeadLeftovers();
  let root = null;
  try {
    root = makeRoot();
    const made = await fillTree(tree.top, base, root, deadlineAt);
    if (made.unavailable !== undefined) {
      removeFolder(root);
      return { unavailable: made.unavailable };
    }
    const folder = root;
    return { dir: made.treeDir, cleanup: () => removeFolder(folder) };
  } catch (error) {
    if (root !== null) removeFolder(root);
    return { unavailable: `the base tree could not be made: ${error.message}` };
  }
}

const stateFolder = () => join(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude', 'state', 'done-check');
const cacheFolder = () => join(stateFolder(), 'base');
const cacheId = (repoId, base, label) => createHash('sha256').update(JSON.stringify([repoId, base, label])).digest('hex');
const areStrings = (...values) => values.every((value) => typeof value === 'string');

/** True when the done-check state folder is a real folder of this user (made when missing), never a link. */
function stateIsPlain() {
  try {
    return privateFolder(stateFolder()) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The old failures cached for one repo, base commit and check label.
 * @param {string} repoId the hashed repo id (never a path)
 * @param {string} base the base commit
 * @param {string} label the check label, for example `vitest`
 * @returns {Promise<Set<string> | null>} the ids (an empty Set when the base had none); null when nothing is cached or the file is
 *   damaged, belongs to another key, or sits behind a link
 */
export async function cachedBase(repoId, base, label) {
  if (!areStrings(repoId, base, label) || !stateIsPlain()) return null;
  try {
    const text = readSessionFile(cacheFolder(), cacheId(repoId, base, label), MAX_CACHE_BYTES);
    const record = typeof text === 'string' ? JSON.parse(text) : null;
    const sameKey = record?.v === CACHE_VERSION && record.repo === repoId && record.base === base && record.label === label;
    return sameKey && Array.isArray(record.ids) && record.ids.every((id) => typeof id === 'string') ? new Set(record.ids) : null;
  } catch {
    return null; // not JSON: a damaged file is no cache
  }
}

/**
 * Stores the old failures of one repo, base commit and check label, replacing an earlier entry.
 * @param {string} repoId the hashed repo id
 * @param {string} base the base commit
 * @param {string} label the check label
 * @param {Set<string> | string[]} ids the failure ids found at the base (may be empty)
 * @returns {Promise<boolean>} true when stored; false for a bad argument, a set over MAX_CACHE_BYTES, a link in the way or a failed write
 */
export async function saveBase(repoId, base, label, ids) {
  if (!areStrings(repoId, base, label) || !stateIsPlain()) return false;
  const text = JSON.stringify({ v: CACHE_VERSION, repo: repoId, base, label, ids: [...ids] });
  return Buffer.byteLength(text) <= MAX_CACHE_BYTES && writeSessionFile(cacheFolder(), cacheId(repoId, base, label), text);
}
