// The Nx command the typecheck gate may run for an edited file: the typecheck target of the one Nx project that holds it.
// Split from lib/typecheck-plan.mjs, which would pass 300 lines with it.
// Exports: nxProjectFolder(file, dir, top), nxTypecheck(dir, folders, platform).
// Invariants: Nx runs one project's typecheck target, never run-many or affected, without the tasks it depends on
// (`--excludeTaskDependencies`: a dependency task prints its own project's errors with paths no rule can tell from the
// edited file's), with the daemon, Nx Cloud and the terminal UI off. The project and its target are read only from
// `project.json` or `package.json` in the project folder (no `nx show`: a target that only a plugin infers is not found).
// `nx` comes only from node_modules/.bin of the git top, and only an Nx that knows `--excludeTaskDependencies` is run: an
// older one hands an unknown flag on to the task's own command, so its result could not be trusted either way.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { SKIPPED, WIN_SAFE_PATH, projectBin, readJsonFile } from './typecheck-plan.mjs';

// No daemon left running after the hook, no call to Nx Cloud, plain output instead of the terminal UI
// (https://nx.dev/docs/reference/environment-variables, "Nx Environment Variables").
const NX_ENV = Object.freeze({ NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false' });
// The project name becomes part of a command (through the shell on Windows): no space, metacharacter, colon or leading dash.
const NX_PROJECT_NAME = /^[\w@][\w@./-]*$/;
// The first Nx whose `nx run` has the option: 19.6.0, "core: add --exclude-task-dependencies flag"
// (https://github.com/nrwl/nx/releases/tag/19.6.0); the option itself: https://nx.dev/docs/reference/nx-commands, `nx run`.
const MIN_NX = Object.freeze({ major: 19, minor: 6 });

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The Nx project folder of an edited file: the nearest folder with a `project.json` from the file's folder up to the git
 * top, never above it; `dir` when there is none (a project declared in the `nx` field of the package's `package.json`).
 * @param {string} file the edited file
 * @param {string} dir its package folder, as a real path
 * @param {string} top the git top (the last of `projectFolders`), as a real path
 * @returns {string} a real path
 */
export function nxProjectFolder(file, dir, top) {
  let folder;
  try {
    folder = realpathSync.native(dirname(file));
  } catch {
    return dir; // the folder vanished since the edit
  }
  const below = relative(top, folder);
  if (below.startsWith('..') || isAbsolute(below)) return dir;
  for (; ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'project.json'))) return folder;
    if (folder === top || dirname(folder) === folder) return dir;
  }
}

// True when the Nx installed at the git top is at least MIN_NX (read from its package.json; unreadable counts as too old).
function knowsExcludeOption(top) {
  const [major, minor] = String(readJsonFile(join(top, 'node_modules', 'nx', 'package.json'))?.version ?? '').split('.').map((part) => Number.parseInt(part, 10));
  return major > MIN_NX.major || (major === MIN_NX.major && minor >= MIN_NX.minor);
}

/**
 * The Nx call for the typecheck target of the project in `dir`: `<git top>/node_modules/.bin/nx run <project>:typecheck
 * --skip-nx-cache --excludeTaskDependencies`, run at the git top with the daemon, Nx Cloud and the terminal UI off. The
 * project and its target are read from `project.json` in `dir` (`name`, `targets.typecheck`) or the `nx` field of its
 * `package.json`.
 * @param {string} dir the Nx project folder, from {@link nxProjectFolder}
 * @param {string[]} folders from `projectFolders`; the last one is the git top
 * @param {string} [platform] defaults to the running platform
 * @returns {{cmd: string, args: string[], env: Record<string, string>, cwd: string} | {skipped: string} | null} null when
 *   this is no Nx project the gate can run: no `nx.json` at the git top, no declared typecheck target, a project name that
 *   is not a plain name, or no `nx` at the git top; the caller then goes on to the tsconfig
 */
export function nxTypecheck(dir, folders, platform = process.platform) {
  const top = folders.at(-1);
  if (!existsSync(join(top, 'nx.json'))) return null;
  const project = readJsonFile(join(dir, 'project.json'));
  const manifest = readJsonFile(join(dir, 'package.json'));
  const target = project?.targets?.typecheck ?? manifest?.nx?.targets?.typecheck;
  const name = project?.name ?? manifest?.nx?.name ?? manifest?.name;
  const nx = projectBin([top], 'nx', platform);
  if (!isRecord(target) || typeof name !== 'string' || !NX_PROJECT_NAME.test(name) || !nx) return null;
  if (!knowsExcludeOption(top)) return { skipped: SKIPPED.unsupportedNx };
  if (platform === 'win32' && !WIN_SAFE_PATH.test(nx)) return { skipped: SKIPPED.unsafeWindowsPath };
  return { cmd: nx, args: ['run', `${name}:typecheck`, '--skip-nx-cache', '--excludeTaskDependencies'], env: NX_ENV, cwd: top };
}
