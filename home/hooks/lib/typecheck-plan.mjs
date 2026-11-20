// The commands the typecheck gate may run for a package and where their binaries may come from; typecheck-gate.mjs puts the
// steps in order (typecheck script, Nx target, nearest tsconfig) and runs them.
// Exports: SKIPPED (the skip reasons), incrementalTypecheck(script, tsMajor, tscPath, buildInfo, platform), typescriptMajor(tscPath),
// projectFolders(dir, timeoutMs), projectBin(folders, tool, platform), readJsonFile(path), nxTypecheck(dir, folders, platform),
// nearestTsconfig(file, dir), tsconfigTypecheck(tsconfig, tsc, buildInfo, platform).
// Invariants: a binary comes only from node_modules/.bin of a folder between the package and the git top, never from above
// it, never a global one and never through npx or a package manager's exec or dlx (nothing is downloaded). Nx runs one
// project's typecheck target, read from the files in the package folder alone (no `nx show`: a target that only a plugin
// infers is not found), never run-many or affected, with the daemon, Nx Cloud and the terminal UI off. A tsc call for a
// tsconfig always sends the build info to the given file, so none lands in the project. The JSON files are read through
// lib/plain-file.mjs (no link followed, no wait on a FIFO, a size cap). A shape that is not understood is a skip with its
// reason, never a run and never a block. On Windows the shell is on and does not quote arguments: a path it cannot take is a skip.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { objectGet, parseJsonc } from '../../tools/refs/lib/jsonc.mjs';
import { gitOut } from './gated-folder.mjs';
import { readPlainFile } from './plain-file.mjs';

const SUPPORTED_TS_MAJORS = [4, 5, 6];
const UNSAFE_SHELL = /[&|;<>$`'"]/;
const WIN_UNSAFE_SCRIPT = /[%^!]/; // cmd.exe expands these even inside a script's flags
const WIN_SAFE_PATH = /^[\w@+=:,./\\-]+$/; // args are not quoted under the Windows shell: no spaces or metacharacters
const NON_INCREMENTAL_FLAGS = ['-b', '--build', '-w', '--watch', '--incremental', '--tsBuildInfoFile'];
const MAX_JSON_BYTES = 1024 * 1024; // 1 MB: a package.json, project.json or tsconfig.json is a few KB; a larger file is not read
// No daemon left running after the hook, no call to Nx Cloud, plain output instead of the terminal UI
// (https://nx.dev/docs/reference/environment-variables, "Nx Environment Variables").
const NX_ENV = Object.freeze({ NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false' });
// The project name becomes part of a command (through the shell on Windows): no space, metacharacter, colon or leading dash.
const NX_PROJECT_NAME = /^[\w@][\w@./-]*$/;

/** Why a typecheck did not run; the run log holds it as `skipped: <reason>`. */
export const SKIPPED = Object.freeze({
  noTsconfig: 'no tsconfig',
  noProjectTsc: 'no project tsc',
  broadScript: 'broad script, no nx target',
  solutionTsconfig: 'solution tsconfig',
  unreadableTsconfig: 'unreadable tsconfig',
  unsupportedTypescript: 'unsupported typescript version',
  unsafeWindowsPath: 'unsafe path on Windows',
  skipEnv: 'skip env',
  budgetSpent: 'budget spent',
});

/**
 * The `tsc` call that typechecks incrementally, or null when the script is not a plain `tsc` call this can extend.
 * On Windows the shell is on and does not quote args, so unsafe paths or script characters also give null.
 * @param {string} script the package's `typecheck` script
 * @param {number} tsMajor major version of the installed typescript
 * @param {string} tscPath path of the `tsc` binary
 * @param {string} buildInfo private tsbuildinfo file for this run
 * @param {string} [platform] defaults to the running platform
 * @returns {{cmd: string, args: string[]} | null}
 */
export function incrementalTypecheck(script, tsMajor, tscPath, buildInfo, platform = process.platform) {
  const [tool, ...flags] = script.trim().split(/\s+/);
  if (tool !== 'tsc' || UNSAFE_SHELL.test(script) || !SUPPORTED_TS_MAJORS.includes(tsMajor)) return null;
  if (platform === 'win32' && (WIN_UNSAFE_SCRIPT.test(script) || ![tscPath, buildInfo].every((p) => WIN_SAFE_PATH.test(p)))) return null;
  const conflicts = flags.some((f) => NON_INCREMENTAL_FLAGS.some((bad) => f === bad || f.startsWith(`${bad}=`)));
  return conflicts ? null : { cmd: tscPath, args: [...flags, '--incremental', '--tsBuildInfoFile', buildInfo] };
}

// Major of the typescript package at `manifest` (null when unreadable, another package, or without a version).
function majorAt(manifest) {
  try {
    const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
    const major = Number.parseInt(version, 10);
    return name === 'typescript' && !Number.isNaN(major) ? major : null;
  } catch {
    return null; // no such manifest here
  }
}

/**
 * Major version of the typescript that the given `tsc` binary belongs to: the package next to its `.bin` folder, else
 * the package that contains the binary's real path. Not the nearest typescript from the project: a hoisted `tsc`
 * must be judged by its own version.
 * @param {string} tscPath path of a `tsc` binary
 * @returns {number | null}
 */
export function typescriptMajor(tscPath) {
  const sibling = majorAt(join(dirname(tscPath), '..', 'typescript', 'package.json'));
  if (sibling !== null) return sibling;
  let real;
  try {
    real = realpathSync(tscPath);
  } catch {
    return null; // tsc vanished
  }
  for (let d = dirname(real); ; d = dirname(d)) {
    const major = majorAt(join(d, 'package.json'));
    if (major !== null) return major;
    if (dirname(d) === d) return null;
  }
}

/**
 * The folders a project binary may come from: the package folder and every folder above it up to the git top that holds
 * it (`git rev-parse --show-toplevel`), as real paths, nearest first; the last one is the top. Only the package folder when
 * it is in no git repository, git does not answer in time, or the folder is gone: nothing above it is trusted then.
 * @param {string} dir the package folder
 * @param {number} timeoutMs the most the one git call may take
 * @returns {string[]}
 */
export function projectFolders(dir, timeoutMs) {
  let real;
  try {
    real = realpathSync.native(dir);
  } catch {
    return [dir]; // the folder vanished since the edit
  }
  const top = gitOut(real, ['rev-parse', '--show-toplevel'], timeoutMs)?.replace(/\r?\n$/, '');
  const below = top ? relative(top, real) : '';
  const levels = below && !below.startsWith('..') && !isAbsolute(below) ? below.split(sep).length : 0;
  const folders = [real];
  for (let level = 0; level < levels; level += 1) folders.push(dirname(folders.at(-1)));
  return folders;
}

/**
 * `node_modules/.bin/<tool>` of the nearest of `folders` that has one.
 * @param {string[]} folders from {@link projectFolders}
 * @param {string} tool `tsc` or `nx`
 * @param {string} [platform] defaults to the running platform (Windows has `.cmd` shims)
 * @returns {string | null} null when the project has none: the caller skips, it never looks further
 */
export function projectBin(folders, tool, platform = process.platform) {
  const name = platform === 'win32' ? `${tool}.cmd` : tool;
  return folders.map((folder) => join(folder, 'node_modules', '.bin', name)).find((bin) => existsSync(bin)) ?? null;
}

/**
 * The value of a JSON file (package.json, project.json).
 * @param {string} path the file
 * @returns {unknown} null when it is missing, not a plain file within 1 MB (a link, a FIFO, a folder), or not JSON
 */
export function readJsonFile(path) {
  try {
    return JSON.parse(readPlainFile(path, MAX_JSON_BYTES));
  } catch {
    return null; // nothing this hook can read: the caller goes on without it
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The Nx call for the typecheck target of the project in `dir`: `<git top>/node_modules/.bin/nx run <project>:typecheck
 * --skip-nx-cache`, run at the git top with the daemon, Nx Cloud and the terminal UI off. The project and its target are
 * read from `project.json` in the package folder (`name`, `targets.typecheck`) or the `nx` field of its `package.json`.
 * @param {string} dir the package folder
 * @param {string[]} folders from {@link projectFolders}; the last one is the git top
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
  if (platform === 'win32' && !WIN_SAFE_PATH.test(nx)) return { skipped: SKIPPED.unsafeWindowsPath };
  return { cmd: nx, args: ['run', `${name}:typecheck`, '--skip-nx-cache'], env: NX_ENV, cwd: top };
}

/**
 * The first `tsconfig.json` from the folder of `file` up to its package folder; one above the package folder is never used.
 * @param {string} file an edited file inside `dir`
 * @param {string} dir its package folder
 * @returns {string | null}
 */
export function nearestTsconfig(file, dir) {
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    const candidate = join(folder, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (folder === dir || dirname(folder) === folder) return null;
  }
}

const isEmptyList = (node) => node?.kind === 'array' && node.items.length === 0;

// A solution-style tsconfig (the Vite template): it only points at other projects, so `tsc -p` on it checks no file and
// exits 0. `files: []` leaves `include` empty too unless `include` is given.
function isSolution(root) {
  const references = objectGet(root, 'references');
  const files = objectGet(root, 'files');
  const include = objectGet(root, 'include');
  const pointsAtProjects = references?.kind === 'array' && references.items.length > 0;
  const ownInputs = include === undefined ? !isEmptyList(files) : !isEmptyList(include) || (files !== undefined && !isEmptyList(files));
  return pointsAtProjects && !ownInputs;
}

/**
 * The tsc call that typechecks one tsconfig without writing in the project: `--noEmit -p <tsconfig>` plus the gate's own
 * `--incremental --tsBuildInfoFile <buildInfo>`, which also redirects the build info of a tsconfig that sets `incremental`,
 * `composite` or its own `tsBuildInfoFile`.
 * @param {string} tsconfig path of the tsconfig.json
 * @param {string | null} tsc the project's tsc from {@link projectBin}
 * @param {string} buildInfo private tsbuildinfo file for this run, outside the project
 * @param {string} [platform] defaults to the running platform
 * @returns {{cmd: string, args: string[]} | {skipped: string}}
 */
export function tsconfigTypecheck(tsconfig, tsc, buildInfo, platform = process.platform) {
  let root;
  try {
    root = parseJsonc(readPlainFile(tsconfig, MAX_JSON_BYTES));
  } catch {
    return { skipped: SKIPPED.unreadableTsconfig }; // not a plain file within the cap, or not JSON with comments
  }
  if (root.kind !== 'object') return { skipped: SKIPPED.unreadableTsconfig };
  if (isSolution(root)) return { skipped: SKIPPED.solutionTsconfig };
  if (!tsc) return { skipped: SKIPPED.noProjectTsc };
  if (!SUPPORTED_TS_MAJORS.includes(typescriptMajor(tsc))) return { skipped: SKIPPED.unsupportedTypescript };
  if (platform === 'win32' && ![tsc, buildInfo, tsconfig].every((path) => WIN_SAFE_PATH.test(path))) return { skipped: SKIPPED.unsafeWindowsPath };
  return { cmd: tsc, args: ['--noEmit', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', buildInfo] };
}
