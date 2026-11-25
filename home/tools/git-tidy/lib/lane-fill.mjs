// Purpose: fill a pool lane folder from the main checkout by APFS clones (`cp -c`, one clone per file), so a lane holds the whole
//   project (tracked files, node_modules, .env, build caches) at almost no disk cost: fillFresh fills a new slot, fillIgnored clones
//   the main checkout's ignored entries back into a reused one. Without clone support (cloneSupport) a new slot is filled by checkout.
// Exports: FILL_ENV, cloneSupport, cloneTree, fillFresh, fillIgnored.
// Invariants:
// - UsageError before any write unless the folder is a pool slot (openSlot) that is new (fillFresh: only its `.git` file) or clean
//   (fillIgnored: an empty `git status`), so no work is lost. The main checkout is only read. Clones land only inside the slot (real
//   path checked) and never on a path already there; the one write outside is `cs-lane-ignored-at-fill` in the slot's git folder.
// - Never cloned (walkMain): `.git`, `.claude/worktrees`, the worktrees inside main, folders holding `.git` or `pyvenv.cfg`, and root
//   `HANDOFF*.md`. `.env` and other ignored local files are cloned (owner decision).
// - argv only, no shell: `/bin/cp -c` on macOS (Node's own clone copies in full there). git paths go in with `-z` and back
//   NUL-separated with `--literal-pathspecs` (`-rf`, `*`, `a<newline>b` stay names). fillFresh ends clean or throws. No reset.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';
import { programOnPath } from './lane-prep.mjs';
import { POOL_FOLDER, commonDirOf, isPoolSlot, poolFolderOf, slotKey } from './lane-slots.mjs';
import { changedFileCount, contains, listWorktrees } from './repo.mjs';

/** `GIT_TIDY_LANE_FILL=checkout` turns cloning off: lanes are filled by checkout, as before. */
export const FILL_ENV = 'GIT_TIDY_LANE_FILL';
const CHECKOUT = 'checkout';
const CLONE = 'clone';
const APFS = 26; // statfs().type of APFS (HFS+ is 25); cp -c onto another file system exits 0 and silently copies in full
const MAC_CP = Object.freeze({ file: '/bin/cp', args: Object.freeze(['-c', '-R', '-P']) });
const GNU_CP_ARGS = Object.freeze(['-R', '-P', '--reflink=always', '--preserve=mode,timestamps']); // GNU cp keeps mtimes only with --preserve
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_ENTRY = '.git';
const VENV_MARKER = 'pyvenv.cfg';
const DEPENDENCY_FOLDER = 'node_modules';
const ROOT_HANDOFF = /^HANDOFF.*\.md$/;
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const FULL_SHA = /^[0-9a-f]{40}$/;
const IGNORED_LIST = Object.freeze(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
/** `<slot's git folder>/cs-lane-ignored-at-fill`: the slot's ignored entries right after its fill, NUL-separated as IGNORED_LIST prints them. */
const IGNORED_AT_FILL = 'cs-lane-ignored-at-fill';
const TEMP_NAME_BYTES = 8;
const PRIVATE_FILE = 0o600;
const MS_PER_SECOND = 1000;

/** Runs git (with `input` on stdin) and returns its stdout untrimmed; a non-zero exit throws naming the command and git's first line. */
function gitOutput(cwd, args, input = undefined) {
  const run = runGit(cwd, args, input);
  if (run.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed in ${cwd}: ${run.stderr.split('\n')[0]}`);
  return run.stdout;
}

/** The entries of a `-z` git list, each kept exactly (a leading space or a newline in a name stays). */
const nulList = (cwd, args) => gitOutput(cwd, args).split('\0').filter((entry) => entry !== '');
/** A path git prints (`/`-separated, a folder with a trailing `/`) in this platform's form. */
const fromGitPath = (path) => join(...path.split('/'));
const isNonEmptyFile = (path) => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true && lstatSync(path).size > 0;
const byCheckout = (why) => ({ mode: CHECKOUT, why });
const noClones = () => ({ entries: 0, skipped: [], warnings: [], linksIntoMain: [] });

function macSupport(mainDir, poolDir) {
  if (statfsSync(mainDir).type !== APFS || statfsSync(poolDir).type !== APFS) return byCheckout('not APFS: cp -c would copy in full');
  if (statSync(mainDir).dev !== statSync(poolDir).dev) return byCheckout('the main checkout and the lane folders are on different volumes');
  return { mode: CLONE, why: 'APFS, one volume' };
}

/** Probes `cp --reflink=always` with one non-empty tracked file, cloned into `poolDir` under a unique name and removed again. */
function linuxSupport(mainDir, poolDir) {
  const tracked = nulList(mainDir, ['ls-files', '-z']).map((path) => join(mainDir, fromGitPath(path))).find(isNonEmptyFile);
  if (tracked === undefined) return byCheckout('no tracked file to probe cp --reflink=always with');
  const probe = join(poolDir, `.cs-lane-fill-probe-${process.pid}-${randomBytes(TEMP_NAME_BYTES).toString('hex')}`);
  const cloned = cloneTree(tracked, probe, 'linux');
  rmSync(probe, { force: true });
  return cloned.ok ? { mode: CLONE, why: 'cp --reflink=always works here' } : byCheckout(`cp --reflink=always failed: ${cloned.why}`);
}

/**
 * Whether new lanes of `mainDir` can be filled by clones into `poolDir` (the pool folder or a slot; both must exist). `env`: FILL_ENV.
 * @returns {{ mode: 'clone'|'checkout', why: string }} clone on one APFS volume (macOS) or where `cp --reflink=always` of a tracked
 *   file into `poolDir` works (Linux), else checkout; why: a short plain reason. Throws when a folder or git cannot be read.
 */
export function cloneSupport(mainDir, poolDir, env = process.env) {
  if (env[FILL_ENV] === CHECKOUT) return byCheckout(`${FILL_ENV}=${CHECKOUT}`);
  if (process.platform === 'darwin') return macSupport(mainDir, poolDir);
  if (process.platform === 'linux') return linuxSupport(mainDir, poolDir);
  return byCheckout(process.platform === 'win32' ? 'Windows: NTFS has no file clones' : `no file clones on ${process.platform}`);
}

function cloneCommand(target, platform) {
  if (platform === 'darwin') return MAC_CP;
  if (platform !== 'linux') return { why: `no file clones on ${platform}` };
  const found = programOnPath(process.env, 'cp', dirname(target)); // never a cp from inside the folder being written
  return found === null ? { why: 'cp is not on PATH' } : { file: found.file, args: [...found.args, ...GNU_CP_ARGS] };
}

/**
 * Clones one entry (a file, a link, or a folder tree file by file) to the absolute `target` (not there yet; its folder is), argv
 * only: `/bin/cp -c -R -P` on darwin, GNU `cp` with GNU_CP_ARGS from a PATH folder on linux. Returns ok false with cp's first error
 * line (cp goes on past an error, so part may be cloned) or why there is no clone: `{ ok: boolean, why?: string }`.
 */
export function cloneTree(source, target, platform = process.platform) {
  const command = cloneCommand(target, platform);
  if (command.why !== undefined) return { ok: false, why: command.why };
  const run = spawnSync(command.file, [...command.args, '--', source, target], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: MAX_OUTPUT_BYTES });
  if (run.error !== undefined) return { ok: false, why: run.error.message };
  return run.status === 0 ? { ok: true } : { ok: false, why: run.stderr.trim().split('\n')[0] || `exit ${run.status ?? run.signal}` };
}

/** The paths of the pool slot `folder` (`<main>/.claude/worktrees/lane-<n>`, a plain folder, a registered non-main worktree of `repo`
 *  whose git folder lies under `<git common dir>/worktrees`); anything else throws UsageError. */
function openSlot(repo, folder) {
  const worktrees = listWorktrees(repo);
  const pool = poolFolderOf(repo, worktrees); // UsageError when there is no main checkout
  const [main] = worktrees;
  if (slotKey(folder) === slotKey(main.path)) throw new UsageError(`${folder} is the main checkout, never a lane: nothing was changed`);
  const tree = worktrees.find((entry) => !entry.main && !entry.missing && slotKey(entry.path) === slotKey(folder));
  if (tree === undefined) throw new UsageError(`${folder} is not a worktree of this repository: nothing was changed`);
  const isPlainFolder = lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!isPlainFolder || !isPoolSlot(repo, folder, worktrees)) throw new UsageError(`${folder} is not a lane folder ${join(pool, 'lane-<n>')}: nothing was changed`);
  const entries = join(commonDirOf(repo), 'worktrees');
  const admin = gitText(folder, ['rev-parse', '--absolute-git-dir']);
  if (!contains(entries, admin)) throw new UsageError(`${folder}: its git folder ${admin} is not under ${entries}: nothing was changed`);
  return { main: realpathSync.native(main.path), slot: realpathSync.native(folder), admin, pool, worktrees };
}

/** True when the link at `path` holds an absolute path into the main checkout: a write through it in a lane would change main. */
const pointsIntoMain = (main, path) => { const target = readlinkSync(path); return isAbsolute(target) && contains(main, target); };

/** A folder's entries, [] when it is gone (the main checkout is a working copy: a running build may delete a folder mid-walk). */
const entriesOf = (folder) => { try { return readdirSync(folder, { withFileTypes: true }); } catch (error) { if (GONE.has(error.code)) return []; throw error; } };

/** Reads one folder of the walk into `found` and adds its subfolders to `pending`. */
function walkFolder(found, main, folder, pending) {
  const entries = entriesOf(join(main, folder));
  if (folder !== '' && entries.some(({ name }) => name === GIT_ENTRY || name === VENV_MARKER)) {
    found.skip.add(folder);
    return;
  }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (folder === '' && ROOT_HANDOFF.test(entry.name)) found.skip.add(path);
    else if (entry.isDirectory() && !found.skip.has(path)) (entry.name === DEPENDENCY_FOLDER ? found.dependencyFolders : pending).push(path);
    else if (entry.isSymbolicLink() && pointsIntoMain(main, join(main, path))) found.linksIntoMain.push(path);
  }
}

/** One walk of the main checkout (relative paths), never into node_modules, a skip target or a link. A folder holding `.git` (a nested
 *  repo, submodule or worktree) would send commits to another repository; one holding `pyvenv.cfg` has scripts naming main's paths. */
function walkMain(main, worktrees) {
  const worktreesInside = worktrees.filter((tree) => !tree.main && !tree.missing && contains(main, tree.path));
  const skip = new Set([GIT_ENTRY, POOL_FOLDER, ...worktreesInside.map((tree) => relative(main, realpathSync.native(tree.path)))]);
  const found = { skip, dependencyFolders: [], linksIntoMain: [] };
  const pending = [''];
  while (pending.length > 0) walkFolder(found, main, pending.pop(), pending);
  return found;
}

/** Every folder above a path in `paths` (relative): the fill enters it and clones its children one by one. */
function foldersAbove(paths) {
  const above = new Set();
  for (const path of paths) for (let folder = dirname(path); folder !== '.'; folder = dirname(folder)) above.add(folder);
  return above;
}

/** True when the relative `path` or a folder above it is in `paths`. */
function isAt(paths, path) {
  for (let at = path; at !== '.'; at = dirname(at)) if (paths.has(at)) return true;
  return false;
}

const warn = (fill, path, text) => fill.warnings.push(`${JSON.stringify(path)}: ${text}`);
/** True when `path` is a real folder (not a link) inside the slot. */
const isFolderIn = (slot, path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true && contains(slot, path);

/** Why nothing may be written at `target`: a path already there, or its folder is missing or lies outside the slot (real path). */
function targetWhy(slot, target) {
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) return 'already in the lane';
  if (statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory() !== true) return 'its folder is not in the lane';
  return contains(slot, dirname(target)) ? null : 'its folder leads out of the lane';
}

/** After a failed clone: a warning, and each node_modules folder of the entry is deleted, so its marker or an install decides. */
function dropFailedClone(fill, path, why) {
  warn(fill, path, `cp failed part-way (${why})`);
  const inside = fill.dependencyFolders.filter((deps) => (deps === path || deps.startsWith(path + sep)) && isFolderIn(fill.slot, join(fill.slot, deps)));
  for (const folder of inside) {
    rmSync(join(fill.slot, folder), { recursive: true, force: true });
    warn(fill, folder, 'deleted after the failed clone (the install fills it again)');
  }
}

/** Makes the folder `path` in the slot (or uses the real folder already there) and clones its children from main one by one. */
function enterFolder(fill, path) {
  const target = join(fill.slot, path);
  const blocked = isFolderIn(fill.slot, target) ? null : targetWhy(fill.slot, target);
  if (blocked !== null) {
    warn(fill, path, `not entered: ${blocked}`);
    return;
  }
  mkdirSync(target, { recursive: true }); // its parent is checked above; a folder already there stays as it is
  for (const name of readdirSync(join(fill.main, path))) cloneEntry(fill, join(path, name));
}

/** Clones the one entry `path` when its target is free (targetWhy). */
function cloneOne(fill, path) {
  const target = join(fill.slot, path);
  const blocked = targetWhy(fill.slot, target);
  const cloned = blocked === null ? cloneTree(join(fill.main, path), target) : null;
  if (cloned === null) warn(fill, path, `not cloned: ${blocked}`);
  else if (cloned.ok) fill.entries += 1;
  else dropFailedClone(fill, path, cloned.why);
}

/** Clones the entry `path` (relative) of the main checkout into the slot, unless kept or skipped; a folder above a skip target is entered. */
function cloneEntry(fill, path) {
  if (isAt(fill.keep, path)) return;
  if (isAt(fill.skip, path)) fill.skipped.push(path);
  else if (fill.enter.has(path) && lstatSync(join(fill.main, path), { throwIfNoEntry: false })?.isDirectory()) enterFolder(fill, path);
  else cloneOne(fill, path);
}

/** Clone mode: one walk of the main checkout, then each entry of `paths` (relative) cloned into the slot, the `kept` ones left alone. */
function cloneFill(slotPaths, paths, kept) {
  const found = walkMain(slotPaths.main, slotPaths.worktrees);
  const keep = new Set(kept.map(fromGitPath));
  const fill = { ...slotPaths, ...found, keep, enter: foldersAbove([...found.skip, ...keep]), entries: 0, skipped: [], warnings: [] };
  for (const path of paths) cloneEntry(fill, path);
  return fill;
}

/** Steps 3-4 after read-tree: refresh, restore the tracked files that differ, clean (no -x); returns the restored count, or throws. */
function repairTracked(slot, target) {
  gitText(slot, ['update-index', '-q', '--refresh']);
  const differing = nulList(slot, ['diff-files', '--name-only', '-z']);
  const restore = ['--literal-pathspecs', 'restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'];
  if (differing.length > 0) gitOutput(slot, restore, differing.join('\0'));
  gitText(slot, ['clean', '-fdq']); // untracked files only: ignored ones (.env, node_modules) stay
  const changed = changedFileCount(slot);
  if (changed === 0) return differing.length;
  const shown = changed === null ? 'git status failed there' : `git status shows ${changed} paths`;
  throw new Error(`${slot} does not match ${target} after the repair (${shown}): claim again, or set ${FILL_ENV}=${CHECKOUT}`);
}

/** Saves the slot's ignored entries as IGNORED_AT_FILL in its git folder, through a fresh temp file renamed over it. */
function saveIgnoredList({ slot, admin }) {
  const temp = join(admin, `${IGNORED_AT_FILL}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}`);
  writeFileSync(temp, gitOutput(slot, IGNORED_LIST), { flag: 'wx', mode: PRIVATE_FILE });
  renameSync(temp, join(admin, IGNORED_AT_FILL));
}

/** The fill's result, once the slot is final: the links into main it still holds (after the clean) get their warning here. */
function fillReport(mode, fill, startedMs, repaired) {
  const links = fill.linksIntoMain.filter((path) => lstatSync(join(fill.slot, path), { throwIfNoEntry: false })?.isSymbolicLink());
  for (const path of links) warn(fill, path, 'an absolute link into the main checkout (a write through it changes main)');
  return { mode, entries: fill.entries, seconds: Number(((Date.now() - startedMs) / MS_PER_SECOND).toFixed(1)), skipped: fill.skipped, repaired, warnings: fill.warnings };
}

/**
 * Fills a new lane (steps 2-4 of "Fill a new lane", virtual-workspace design) outside the pool lock, after
 * `git worktree add --no-checkout --detach` and before `git switch -c`. In checkout mode the tracked files come from the index.
 * @param {object} repo openRepo's result
 * @param {{ folder: string, target: string }} lane folder: a pool slot holding only its `.git` file; target: the full sha to fill with
 * @returns {{ mode: 'clone'|'checkout', entries: number, seconds: number, skipped: string[], repaired: number, warnings: string[] }}
 *   entries: clones made (one cp each); skipped: skip-list paths left out; repaired: tracked files restored after the clones
 * @throws {UsageError} before any write (not a pool slot, not empty, no full sha); Error when git fails or the status stays dirty
 */
export function fillFresh(repo, { folder, target }) {
  const startedMs = Date.now();
  const paths = openSlot(repo, folder);
  if (typeof target !== 'string' || !FULL_SHA.test(target)) throw new UsageError(`target needs a full 40-character sha, got ${JSON.stringify(target)}`);
  const present = readdirSync(paths.slot).filter((name) => name !== GIT_ENTRY);
  if (present.length > 0) throw new UsageError(`${folder} holds ${present.length} entries besides .git: only a folder just added with --no-checkout is filled`);
  const { mode } = cloneSupport(paths.main, paths.pool);
  gitText(paths.slot, ['read-tree', target]); // before the clones, so a bad target fails at once
  if (mode === CHECKOUT) gitText(paths.slot, ['checkout-index', '--all', '-u']); // the slot is empty: nothing is overwritten
  const fill = mode === CHECKOUT ? noClones() : cloneFill(paths, readdirSync(paths.main), []);
  const repaired = repairTracked(paths.slot, target);
  saveIgnoredList(paths);
  return fillReport(mode, fill, startedMs, repaired);
}

/**
 * Clones the main checkout's ignored entries (`.env`, `dist`, `.husky/_`), minus the skip list and `except`, back into a reused lane
 * right after the claim's switch and clean; then `git clean -fdq`, since an entry the lane's own rules do not ignore would show up as
 * untracked and be committed. In checkout mode nothing is cloned.
 * @param {object} repo openRepo's result
 * @param {{ folder: string, except?: string[] }} lane except: repo-relative dependency folders the claim kept, left as they are
 * @returns {ReturnType<typeof fillFresh>} repaired is always 0
 * @throws {UsageError} before any write (not a pool slot, or `git status` not empty); Error when git fails
 */
export function fillIgnored(repo, { folder, except = [] }) {
  const startedMs = Date.now();
  const paths = openSlot(repo, folder);
  const changed = changedFileCount(paths.slot);
  if (changed !== 0) throw new UsageError(`${folder} is not clean (git status: ${changed ?? 'failed'}): only a lane just switched and cleaned is filled`);
  const { mode } = cloneSupport(paths.main, paths.pool);
  const fill = mode === CHECKOUT ? noClones() : cloneFill(paths, nulList(paths.main, IGNORED_LIST).map(fromGitPath), except);
  if (mode === CLONE) gitText(paths.slot, ['clean', '-fdq']);
  saveIgnoredList(paths);
  return fillReport(mode, fill, startedMs, 0);
}
