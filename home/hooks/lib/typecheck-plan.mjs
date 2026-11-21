// The tsc commands the typecheck gate may run for a package and where a project's binaries may come from. typecheck-gate.mjs
// puts the steps in order (typecheck script, Nx target of lib/typecheck-nx.mjs, nearest tsconfig); lib/typecheck-run.mjs runs them.
// Exports: SKIPPED (the skip reasons), WIN_SAFE_PATH, incrementalTypecheck(script, tsMajor, tscPath, buildInfo, platform),
// typescriptMajor(tscPath), projectFolders(dir, timeoutMs), projectBin(folders, tool, platform), readJsonFile(path),
// nearestTsconfig(file, dir), tsconfigTypecheck(tsconfig, tsc, buildInfo, platform), configSkip(stdout), pathKey(path),
// splitListedFiles(output).
// Invariants: a binary comes only from node_modules/.bin of a folder between the package and the git top, never from above
// it and never a global one; the gate itself calls no npx and no package manager's exec or dlx. A tsc call for a tsconfig
// always sends the build info to the given file, so none lands in the project, and always asks for plain output
// (`--pretty false`: a tsconfig's `pretty` colours the lines even on a pipe, and no line parses then). A tsconfig the gate
// cannot check truthfully is a skip with its reason, never a run and never a block: project references (without `-b` tsc
// reads the built `.d.ts` of a referenced project, so an unbuilt or stale one gives errors about correct code), a solution
// file, `generateTrace` (it writes outside the project). Every JSON file is read through lib/plain-file.mjs (no link
// followed, no wait on a FIFO, a size cap). On Windows the shell is on and does not quote arguments: a path it cannot take
// is a skip.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { objectGet, parseJsonc } from '../../tools/refs/lib/jsonc.mjs';
import { gitOut } from './gated-folder.mjs';
import { readPlainFile } from './plain-file.mjs';

const SUPPORTED_TS_MAJORS = [4, 5, 6];
const UNSAFE_SHELL = /[&|;<>$`'"]/;
const WIN_UNSAFE_SCRIPT = /[%^!]/; // cmd.exe expands these even inside a script's flags
/** A path the unquoted Windows shell takes as one argument: no spaces or metacharacters. */
export const WIN_SAFE_PATH = /^[\w@+=:,./\\-]+$/;
const NON_INCREMENTAL_FLAGS = ['-b', '--build', '-w', '--watch', '--incremental', '--tsBuildInfoFile'];
const PLAIN_OUTPUT = ['--pretty', 'false']; // the command line wins over a tsconfig's `pretty`
const MAX_JSON_BYTES = 1024 * 1024; // 1 MB: a package.json, project.json or tsconfig.json is a few KB; a larger file is not read
const LOCATED_LINE = /\(\d+,\d+\): |:\d+:\d+/; // a diagnostic names a position; a `--listFiles` line is a bare path
const FOLDS_CASE = ['darwin', 'win32']; // platforms whose usual file systems treat `A.ts` and `a.ts` as one file

/** Why a typecheck did not run; the run log holds it as `skipped: <reason>`. */
export const SKIPPED = Object.freeze({
  noTsconfig: 'no tsconfig',
  noProjectTsc: 'no project tsc',
  broadScript: 'broad script, no nx target',
  solutionTsconfig: 'solution tsconfig',
  projectReferences: 'project references',
  unreadableTsconfig: 'unreadable tsconfig',
  writesTrace: 'tsconfig writes a trace',
  notInTsconfig: 'not in tsconfig',
  unsupportedTypescript: 'unsupported typescript version',
  unsupportedNx: 'unsupported nx version',
  unsafeWindowsPath: 'unsafe path on Windows',
  noTempFolder: 'no temp folder',
  skipEnv: 'skip env',
  atEdit: 'at-edit mode',
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
  return conflicts ? null : { cmd: tscPath, args: [...flags, '--incremental', '--tsBuildInfoFile', buildInfo, ...PLAIN_OUTPUT] };
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

// Major of the typescript package at `manifest` (null when unreadable, another package, or without a version).
function majorAt(manifest) {
  const { name, version } = readJsonFile(manifest) ?? {};
  const major = Number.parseInt(version, 10);
  return name === 'typescript' && !Number.isNaN(major) ? major : null;
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

// Why this tsconfig cannot be checked with `tsc -p`, or null. A solution-style one (the Vite template) only points at other
// projects, so tsc checks no file and exits 0 (`files: []` leaves `include` empty too unless `include` is given); any other
// one with references would be checked against the built output of those projects, not their source.
function referencesSkip(root) {
  const references = objectGet(root, 'references');
  if (references?.kind !== 'array' || references.items.length === 0) return null;
  const files = objectGet(root, 'files');
  const include = objectGet(root, 'include');
  const ownInputs = include === undefined ? !isEmptyList(files) : !isEmptyList(include) || (files !== undefined && !isEmptyList(files));
  return ownInputs ? SKIPPED.projectReferences : SKIPPED.solutionTsconfig;
}

/**
 * The tsc calls that typecheck one tsconfig without writing in the project: `--noEmit -p <tsconfig>` plus the gate's own
 * `--incremental --tsBuildInfoFile <buildInfo>` (it also redirects the build info of a tsconfig that sets `incremental`,
 * `composite` or its own `tsBuildInfoFile`), `--pretty false`, `--emitDeclarationOnly false` (TypeScript 4 and 5 refuse
 * `emitDeclarationOnly` beside `noEmit` and then check nothing) and `--listFiles` (the files of the program, so an edited
 * file outside it is seen). `config` is the call to make first: `--showConfig` prints the resolved options and writes nothing.
 * @param {string} tsconfig path of the tsconfig.json
 * @param {string | null} tsc the project's tsc from {@link projectBin}
 * @param {string} buildInfo private tsbuildinfo file for this run, outside the project
 * @param {string} [platform] defaults to the running platform
 * @returns {{cmd: string, args: string[], config: {cmd: string, args: string[]}, listsFiles: true} | {skipped: string}}
 */
export function tsconfigTypecheck(tsconfig, tsc, buildInfo, platform = process.platform) {
  let root;
  try {
    root = parseJsonc(readPlainFile(tsconfig, MAX_JSON_BYTES));
  } catch {
    return { skipped: SKIPPED.unreadableTsconfig }; // not a plain file within the cap, or not JSON with comments
  }
  if (root.kind !== 'object') return { skipped: SKIPPED.unreadableTsconfig };
  const references = referencesSkip(root);
  if (references) return { skipped: references };
  if (!tsc) return { skipped: SKIPPED.noProjectTsc };
  if (!SUPPORTED_TS_MAJORS.includes(typescriptMajor(tsc))) return { skipped: SKIPPED.unsupportedTypescript };
  if (platform === 'win32' && ![tsc, buildInfo, tsconfig].every((path) => WIN_SAFE_PATH.test(path))) return { skipped: SKIPPED.unsafeWindowsPath };
  const args = ['--noEmit', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', buildInfo, ...PLAIN_OUTPUT, '--emitDeclarationOnly', 'false', '--listFiles'];
  return { cmd: tsc, args, config: { cmd: tsc, args: ['--showConfig', '-p', tsconfig] }, listsFiles: true };
}

/**
 * Why the resolved config that `tsc --showConfig` printed must not be run, or null. `generateTrace`, set in the tsconfig or
 * in one it extends, makes `tsc --noEmit` write trace files wherever it points, and no command-line flag turns it off.
 * @param {string} stdout what `--showConfig` printed
 * @returns {string | null} a {@link SKIPPED} reason
 */
export function configSkip(stdout) {
  let config;
  try {
    config = JSON.parse(stdout);
  } catch {
    return SKIPPED.unreadableTsconfig; // not the JSON every supported tsc prints
  }
  if (typeof config !== 'object' || config === null) return SKIPPED.unreadableTsconfig;
  return config.compilerOptions?.generateTrace === undefined ? null : SKIPPED.writesTrace;
}

/** A path as it is compared with the paths tsc lists: forward slashes, and one case where the file system folds it. */
export function pathKey(path, platform = process.platform) {
  const slashed = path.replace(/\\/g, '/');
  return FOLDS_CASE.includes(platform) ? slashed.toLowerCase() : slashed;
}

/**
 * Splits what a tsc run with `--listFiles` printed into the files of its program and everything else.
 * @param {string} output its stdout
 * @returns {{listed: Set<string>, rest: string}} `listed`: the {@link pathKey} of every listed file (empty when tsc listed
 *   none, for example after an option error); `rest`: the other lines, for the diagnostics parser
 */
export function splitListedFiles(output) {
  const listed = new Set();
  const rest = [];
  for (const line of output.split(/\r?\n/)) {
    if (isAbsolute(line) && !LOCATED_LINE.test(line)) listed.add(pathKey(line));
    else rest.push(line);
  }
  return { listed, rest: rest.join('\n') };
}
