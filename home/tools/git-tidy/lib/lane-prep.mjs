// Purpose: prepare a claimed lane folder: install what its tip needs, generically, so its tests do not fail for a missing package (a
//   hand-made worktree has no node_modules). For each tracked lockfile: package-lock.json -> `npm ci`, pnpm-lock.yaml -> `pnpm install
//   --frozen-lockfile` (pnpm keeps one lockfile, at its workspace root), yarn.lock -> `yarn install --immutable`, run in that lockfile's folder.
// Exports: LOCKFILE_INSTALLS, PREP_MARKER, prepareLane, installFolder.
// Invariants (trust boundary F10): the command is chosen from the lockfile's name only, from LOCKFILE_INSTALLS; argv, no shell; no script
//   of the repository is run by name (its lockfile's own lifecycle scripts run as the package manager runs them in any checkout). The
//   program is found on PATH, never through a relative PATH entry or one inside the lane folder. A folder whose node_modules holds the
//   marker for the same lockfile sha256 is skipped; the marker is written only after a successful install, never through a link.
//   A lockfile that is a link, or over MAX_LOCKFILE_BYTES, is refused (not ready), never followed.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { gitText } from './git.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

/** In this order: a folder holding two lockfiles is installed by the first that matches. */
export const LOCKFILE_INSTALLS = Object.freeze([
  Object.freeze({ lockfile: 'pnpm-lock.yaml', program: 'pnpm', args: Object.freeze(['install', '--frozen-lockfile']) }),
  Object.freeze({ lockfile: 'yarn.lock', program: 'yarn', args: Object.freeze(['install', '--immutable']) }),
  Object.freeze({ lockfile: 'package-lock.json', program: 'npm', args: Object.freeze(['ci']) }),
]);
/** `<folder>/node_modules/.cs-lane-prep.json`: `{ lockfile, sha256 }` of the lockfile that node_modules was installed from. */
export const PREP_MARKER = '.cs-lane-prep.json';
const DEPENDENCY_FOLDER = 'node_modules';
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_MARKER_BYTES = 4096;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000; // a cold npm ci of a big tree; a timeout is a failure, never ready
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Windows: npm, pnpm and yarn are .cmd shims that only a shell runs; their JavaScript entry beside the shim runs under node instead.
const WIN32_ENTRIES = Object.freeze({ npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'], pnpm: ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'], yarn: ['node_modules', 'yarn', 'bin', 'yarn.js'] });

const isInside = (outer, inner) => {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const realOr = (path) => { try { return realpathSync.native(path); } catch { return path; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** `{ file, args }` to run `program` with, from an absolute PATH folder outside `lane`; null when it is not installed. */
function programOnPath(env, program, lane) {
  const realLane = realOr(lane);
  for (const folder of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (folder === '' || !isAbsolute(folder) || isInside(realLane, realOr(folder))) continue; // never a program the repository brings
    if (process.platform === 'win32') {
      if (isFile(join(folder, `${program}.exe`))) return { file: join(folder, `${program}.exe`), args: [] };
      const entry = join(folder, ...WIN32_ENTRIES[program]);
      if (isFile(join(folder, `${program}.cmd`)) && isFile(entry)) return { file: process.execPath, args: [entry] };
      continue;
    }
    const file = join(folder, program);
    try {
      accessSync(file, constants.X_OK);
      if (isFile(file)) return { file, args: [] };
    } catch {
      // not there or not executable: the next PATH folder
    }
  }
  return null;
}

/** The installs the tip of `lane` needs: `[{ dir, lockfile, program, args }]`, one per folder, root first. */
function plannedInstalls(lane) {
  const listed = gitText(lane, ['ls-files', '-z', '--', ...LOCKFILE_INSTALLS.map(({ lockfile }) => `:(glob)**/${lockfile}`)]).split('\0');
  const byDir = new Map();
  for (const path of listed.filter((entry) => entry !== '' && !entry.split('/').includes(DEPENDENCY_FOLDER))) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.slice(path.lastIndexOf('/') + 1)]);
  }
  return [...byDir.entries()].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : a > b ? 1 : 0)).map(([dir, names]) => {
    const install = LOCKFILE_INSTALLS.find(({ lockfile }) => names.includes(lockfile));
    return { dir, ...install };
  });
}

const sha256Of = (text) => createHash('sha256').update(text).digest('hex');

/** The marker's `{ lockfile, sha256 }`, or null when node_modules or the marker is missing, a link or not JSON of that shape. */
function markerOf(folder) {
  const modules = join(folder, DEPENDENCY_FOLDER);
  if (!lstatSync(modules, { throwIfNoEntry: false })?.isDirectory()) return null;
  try {
    const value = JSON.parse(readPlainFile(join(modules, PREP_MARKER), MAX_MARKER_BYTES));
    return typeof value?.lockfile === 'string' && typeof value?.sha256 === 'string' ? value : null;
  } catch {
    return null; // missing, a link or torn: install again
  }
}

/** Writes the marker through a fresh temp file renamed over it, so a planted link at its name is replaced, never followed. */
function writeMarker(folder, marker) {
  const modules = join(folder, DEPENDENCY_FOLDER);
  if (!lstatSync(modules, { throwIfNoEntry: false })?.isDirectory()) return; // nothing installed there: no marker, the next claim installs again
  const temp = join(modules, `${PREP_MARKER}.${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  renameSync(temp, join(modules, PREP_MARKER));
}

const installEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_'))); // a hook's GIT_DIR must not leak in

/** The last line of a failed run's output, for a one-line reason. */
const lastLine = (text) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1);

/** Runs one install; null when it worked, else why. */
function runInstall(lane, install, env, timeoutMs) {
  const found = programOnPath(env, install.program, lane);
  if (found === null) return `${install.program} is not on PATH`;
  const run = spawnSync(found.file, [...found.args, ...install.args], {
    cwd: join(lane, install.dir), env: installEnv(env), encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error !== undefined) return run.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000} s` : run.error.message;
  return run.status === 0 ? null : `exit ${run.status ?? run.signal}: ${lastLine(run.stderr ?? '') ?? lastLine(run.stdout ?? '') ?? 'no output'}`;
}

/** The lockfile's sha256, or why it cannot be read (a link, too big). */
function lockfileHash(lane, install) {
  try {
    return { sha256: sha256Of(readPlainFile(join(lane, install.dir, install.lockfile), MAX_LOCKFILE_BYTES)) };
  } catch (error) {
    return { why: `${install.lockfile} cannot be read as a plain file (${error.code ?? error.message})` };
  }
}

/**
 * Installs what the checked-out tip of `lane` needs (see the header).
 * @param {string} lane the lane folder (a worktree)
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] PATH and the rest of the installs' environment; their timeout
 * @returns {{ ready: boolean, installs: Array<{ dir: string, command: string, outcome: 'installed'|'up to date'|'failed', why?: string }> }}
 *   ready false at the first failed install (the later ones are not run)
 * @throws {Error} when git cannot list the lockfiles
 */
export function prepareLane(lane, { env = process.env, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  const installs = [];
  for (const install of plannedInstalls(lane)) {
    const command = [install.program, ...install.args].join(' ');
    const folder = join(lane, install.dir);
    const hash = lockfileHash(lane, install);
    const marker = markerOf(folder);
    if (hash.sha256 !== undefined && marker?.lockfile === install.lockfile && marker.sha256 === hash.sha256) {
      installs.push({ dir: install.dir, command, outcome: 'up to date' });
      continue;
    }
    const why = hash.why ?? runInstall(lane, install, env, timeoutMs);
    if (why !== null) return { ready: false, installs: [...installs, { dir: install.dir, command, outcome: 'failed', why }] };
    writeMarker(folder, { lockfile: install.lockfile, sha256: hash.sha256 });
    installs.push({ dir: install.dir, command, outcome: 'installed' });
  }
  return { ready: true, installs };
}

/** The folder an install of `dir` runs in, for the "to finish" line. */
export const installFolder = (lane, dir) => (dir === '.' ? lane : join(lane, dir.split('/').join(sep)));
