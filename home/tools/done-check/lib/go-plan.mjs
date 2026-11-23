// Decides the Go commands the done-check runs for one change (fixes spec section 7, go-checks): per Go module touched by the change,
// `go vet` (types), `gofmt -l` (lint) and `go test -json` (tests) as fixed argv commands. It runs nothing and reads no tool output.
// Exports: GO_FILE, isGoWide(path), goBinary(env), goDataFiles(top, paths), goModulesOf(top, paths), planGoChecks(context, scope, { full }),
//   planGo(context, module, { full }), goArgsOf(cmd), withGoArgs(cmd, args), goPackageArg(dir).
// What runs (not full): go vet and go test of the package folders of the changed .go files; a changed non-Go file (testdata, an embedded
//   .sql) adds go test of the nearest folder above it that holds .go files; gofmt -l of the changed .go files. A go.mod, go.sum or
//   go.work change, a deleted package (its folder holds no .go file any more: an importer may break anywhere) or `full` widens vet (and,
//   except for the deleted package, test) to `./...` of the module. vendor/ is never run; `testdata`, `_x` and `.x` folders are data
//   (the go tool skips them as packages).
// Invariants: repo text is untrusted: every path is an argv element after the fixed flags and starts with `./` (or is `.`), so a name
//   like `-x` is never a flag; no shell; a path with a control character is never passed (it is named not run instead); argv groups stay
//   under the detect.mjs command-line limit (the caller's `inGroups`). go.mod is read only for its `module` line (size-capped), which
//   only turns go test's import paths into folders. Go and gofmt are found on PATH (go.exe on Windows), never in the repo.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** A Go source file. */
export const GO_FILE = /\.go$/;
const GO_WIDE_NAMES = new Set(['go.mod', 'go.sum', 'go.work', 'go.work.sum']);
const DOC_FILE = /\.(?:md|markdown|mdx)$/i; // docs beside Go code change no build and no test
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/; // a name go's own output could not print on one line
const MODULE_LINE = /^module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/m;
const GO_MOD_MAX_BYTES = 1024 * 1024;
const MAX_DATA_CANDIDATES = 200; // changed non-Go files looked up at most; more is a bulk edit, not data a package embeds
const VENDOR = 'vendor';
const TESTDATA = 'testdata';
/** The fixed arguments of each Go command; the paths follow them. */
const FIXED_ARGS = Object.freeze({ 'go-vet': ['vet'], gofmt: ['-l'], 'go-test': ['test', '-json'] });
const KINDS = ['types', 'lint', 'tests'];

const withSlashes = (path) => path.split(sep).join('/');
const isInside = (top, path) => {
  const inside = relative(top, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
};
const skip = (kind, why, label) => ({ kind, why, label });
/** A folder the go tool never treats as a package: `testdata`, or a name starting with `_` or `.`. */
const isSkippedFolder = (part) => part === TESTDATA || part.startsWith('_') || part.startsWith('.');

/** True for go.mod, go.sum, go.work and go.work.sum: a change there can change every package of the module. */
export function isGoWide(path) {
  return GO_WIDE_NAMES.has(basename(path));
}

/** The first executable file named `name` in the PATH of `env`, as an absolute path; null when none. */
function onPath(env, name) {
  const path = env.PATH ?? env.Path ?? '';
  for (const folder of path.split(delimiter)) {
    if (folder === '' || !isAbsolute(folder)) continue; // a relative PATH entry would find a program in the repo
    const file = join(folder, name);
    try {
      if (!statSync(file).isFile()) continue;
      if (process.platform !== 'win32') accessSync(file, constants.X_OK);
      return file;
    } catch {
      continue; // missing or not executable: the next PATH folder
    }
  }
  return null;
}

const exeName = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/**
 * The go program: the first `go` (`go.exe` on Windows) on the PATH of `env`.
 * @param {Record<string, string|undefined>} env the environment whose PATH is searched
 * @returns {string|null} its absolute path, or null when go is not installed
 */
export function goBinary(env) {
  return onPath(env, exeName('go'));
}

/** gofmt beside the real go binary (the same toolchain), else the first one on PATH; null when none. */
function gofmtBinary(env, go) {
  try {
    const sibling = join(dirname(realpathSync(go)), exeName('gofmt'));
    if (existsSync(sibling)) return sibling;
  } catch {
    // a go link that cannot be resolved: fall back to PATH
  }
  return onPath(env, exeName('gofmt'));
}

/** The nearest folder from `dir` up to `top` that holds a go.mod, or null. */
function moduleRootOf(top, dir) {
  for (let at = dir; isInside(top, at); at = dirname(at)) {
    if (existsSync(join(at, 'go.mod'))) return at;
    if (at === top || dirname(at) === at) return null;
  }
  return null;
}

/** A cache of "does this folder hold a .go file" answers for one call. */
function goFolderCheck() {
  const known = new Map();
  return (dir) => {
    if (!known.has(dir)) {
      let holds = false;
      try {
        holds = readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && GO_FILE.test(entry.name));
      } catch {
        holds = false; // a folder that is gone or unreadable holds nothing to run
      }
      known.set(dir, holds);
    }
    return known.get(dir);
  };
}

/** The nearest folder from `dir` up to its module root that holds .go files; null when a package.json (a JS package) or the top comes first. */
function goFolderAbove(top, dir, holdsGo) {
  for (let at = dir; isInside(top, at); at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return null;
    if (holdsGo(at)) return at;
    if (existsSync(join(at, 'go.mod')) || at === top || dirname(at) === at) return null;
  }
  return null;
}

/**
 * Of changed non-Go files, the ones that are Go data: inside a Go module, below a folder that holds .go files (testdata, an embedded
 * file), with no package.json between; Markdown is never data. scope.mjs adds them to Scope.named so the change is checked.
 * @param {string} top the worktree (absolute)
 * @param {string[]} paths repo-relative paths with `/`
 * @returns {string[]} the Go data paths, in the order given
 */
export function goDataFiles(top, paths) {
  const holdsGo = goFolderCheck();
  const candidates = paths.filter((path) => !GO_FILE.test(path) && !isGoWide(path) && !DOC_FILE.test(path) && !path.split('/').includes('node_modules'));
  return candidates.slice(0, MAX_DATA_CANDIDATES).filter((path) => {
    const dir = dirname(join(top, path));
    return moduleRootOf(top, dir) !== null && goFolderAbove(top, dir, holdsGo) !== null;
  });
}

/**
 * The Go modules a change touches: the nearest go.mod of each changed path (up to the top), with the paths it holds.
 * @param {string} top the worktree (absolute)
 * @param {string[]} paths repo-relative changed paths that are Go's (.go files, go.mod/go.sum/go.work, Go data files)
 * @returns {{ modules: { root: string, files: string[], wide: boolean }[], outside: string[] }} `root` absolute, `files` repo-relative;
 *   `wide` when go.mod, go.sum or go.work changed; `outside`: paths in no module (no go.mod above them, or a go.work with no touched module)
 */
export function goModulesOf(top, paths) {
  const byRoot = new Map();
  const outside = [];
  const works = [];
  for (const path of paths) {
    const abs = join(top, path);
    if (!isInside(top, abs)) continue; // a path that climbs out of the project is never used
    if (basename(path).startsWith('go.work')) { works.push(path); continue; }
    const root = moduleRootOf(top, dirname(abs));
    if (root === null) { outside.push(path); continue; }
    if (!byRoot.has(root)) byRoot.set(root, { root, files: [], wide: false });
    const entry = byRoot.get(root);
    entry.files.push(path);
    if (isGoWide(path)) entry.wide = true;
  }
  for (const work of works) {
    const folder = dirname(join(top, work));
    const under = [...byRoot.values()].filter((entry) => isInside(folder, entry.root));
    if (under.length === 0) outside.push(work);
    for (const entry of under) entry.wide = true;
  }
  const modules = [...byRoot.values()].sort((left, right) => (left.root < right.root ? -1 : 1));
  return { modules, outside };
}

/** The module path of go.mod (for go test's import paths); '' when the line is missing or the file cannot be read. */
function modulePathOf(root) {
  try {
    const file = join(root, 'go.mod');
    if (!lstatSync(file).isFile() || lstatSync(file).size > GO_MOD_MAX_BYTES) return '';
    return MODULE_LINE.exec(readFileSync(file, 'utf8'))?.[2] ?? '';
  } catch {
    return ''; // go itself reports a broken go.mod; the ids then keep the import path
  }
}

/** A module-relative folder as a go package argument: `.` for the module root, else `./<dir>` (never a flag). */
export function goPackageArg(dir) {
  const path = withSlashes(dir);
  return path === '' || path === '.' ? '.' : `./${path}`;
}

/** The path arguments of a Go command (everything after its fixed flags). */
export function goArgsOf(cmd) {
  return cmd.argv.slice(1 + FIXED_ARGS[cmd.parse].length);
}

/** The same Go command with other path arguments (a base or rerun copy). */
export function withGoArgs(cmd, args) {
  return { ...cmd, argv: [...cmd.argv.slice(0, 1 + FIXED_ARGS[cmd.parse].length), ...args] };
}

/** Sorts the module's changed paths into what each command gets. */
function classify(top, module) {
  const holdsGo = goFolderCheck();
  const found = { gofmt: [], vetDirs: new Set(), testDirs: new Set(), vetAll: false, vendorOnly: 0, unsafe: 0, data: 0 };
  for (const path of module.files) {
    const abs = join(top, path);
    const parts = withSlashes(relative(module.root, abs)).split('/');
    if (CONTROL_CHARACTER.test(path)) { found.unsafe += 1; continue; }
    if (parts[0] === VENDOR) { found.vendorOnly += 1; continue; }
    if (isGoWide(path)) continue;
    const folders = parts.slice(0, -1);
    const firstSkipped = folders.findIndex(isSkippedFolder);
    if (!GO_FILE.test(path) || firstSkipped >= 0) {
      found.data += 1;
      // search from above the first folder the go tool skips: `./x/testdata` named on the command line would be built as a package
      const start = firstSkipped >= 0 ? join(module.root, ...folders.slice(0, firstSkipped)) : dirname(abs);
      const dir = goFolderAbove(top, start, holdsGo);
      if (dir !== null && isInside(module.root, dir)) found.testDirs.add(relative(module.root, dir));
      continue;
    }
    const dir = dirname(abs);
    if (existsSync(abs) && lstatSync(abs).isFile()) found.gofmt.push(withSlashes(relative(module.root, abs)));
    if (!holdsGo(dir)) { found.vetAll = true; continue; } // the package is gone: its importers may break anywhere
    found.vetDirs.add(relative(module.root, dir));
    found.testDirs.add(relative(module.root, dir));
  }
  return found;
}

/** The skipped entries of a module that ran nothing although Go files changed, and of names that were not passed. */
function notesOf(found, cmds, where) {
  const notes = [];
  if (found.unsafe > 0) notes.push(skip('lint', 'error', `${where}go: ${found.unsafe} changed path(s) with a control character not checked`));
  if (cmds.length > 0) return notes;
  if (found.vendorOnly > 0 && found.data === 0) notes.push(skip('tests', 'no-related', `${where}go: only vendor/ changed (never run)`));
  else if (found.data > 0) notes.push(skip('tests', 'no-related', `${where}go: no package folder holds the changed files`));
  return notes;
}

/**
 * Splits a change into its Go part, planned here per module, and the rest, which the JS planner gets.
 * @param {{ top: string, env: Record<string, string|undefined>, inGroups: Function }} context as planGo's, without `go` (found here)
 * @param {import('./contract.mjs').Scope} scope the change
 * @param {{ full?: boolean }} [options] passed to planGo
 * @returns {{ packages: { root: string, pm: 'go', cmds: object[] }[], skipped: object[], rest: import('./contract.mjs').Scope }} `rest` is
 *   `scope` itself when the change holds nothing of Go's, so a JS-only plan is made from the very same input as before
 */
export function planGoChecks(context, scope, { full = false } = {}) {
  const goData = new Set(goDataFiles(scope.top, scope.named ?? []));
  const isGoCode = (path) => GO_FILE.test(path);
  const goPaths = [...scope.files.filter(isGoCode), ...scope.wide.filter(isGoWide), ...goData];
  if (goPaths.length === 0) return { packages: [], skipped: [], rest: scope };
  const rest = { ...scope, files: scope.files.filter((path) => !isGoCode(path)), wide: scope.wide.filter((path) => !isGoWide(path)), named: (scope.named ?? []).filter((path) => !goData.has(path)) };
  const { modules, outside } = goModulesOf(scope.top, goPaths);
  const goContext = { ...context, go: goBinary(context.env) };
  const skipped = outside.length === 0 ? [] : KINDS.map((kind) => skip(kind, 'not-supported', `${kind}: go: ${outside.length} changed file(s) in no go.mod module`));
  const packages = [];
  for (const module of modules) {
    const planned = planGo(goContext, module, { full });
    skipped.push(...planned.skipped);
    packages.push({ root: module.root, pm: 'go', cmds: planned.cmds });
  }
  return { packages, skipped, rest };
}

/**
 * The Go commands for one module of the change.
 * @param {{ top: string, go: string|null, env: Record<string, string|undefined>, inGroups: (root: string, spec: object) => object[] }} context
 *   `go` from goBinary (null: not installed); `inGroups` splits the paths of one command into argv groups (detect.mjs commandsFor)
 * @param {{ root: string, files: string[], wide: boolean }} module one entry of goModulesOf
 * @param {{ full?: boolean }} [options] `full`: vet and test the whole module (`./...`), as at a land
 * @returns {{ skipped: { kind: string, why: string, label: string }[], cmds: object[] }} Cmds as detect.mjs makes them plus
 *   `parse: 'go-vet'|'gofmt'|'go-test'` (and `goModule`, the module path, on go vet and go test)
 */
export function planGo(context, module, { full = false } = {}) {
  const where = module.root === context.top ? '' : `${withSlashes(relative(context.top, module.root))}: `;
  if (!context.go) return { skipped: KINDS.map((kind) => skip(kind, 'go-not-installed', `${where}${kind}: go: not installed`)), cmds: [] };
  const found = classify(context.top, module);
  const whole = full || module.wide;
  const vetArgs = whole || found.vetAll ? ['./...'] : [...found.vetDirs].sort().map(goPackageArg);
  const testArgs = whole ? ['./...'] : [...found.testDirs].sort().map(goPackageArg);
  const cmds = [];
  const skipped = [];
  const goCmds = (parse, kind, label, binary, args, extra = {}) => context.inGroups(module.root, { kind, label, files: args, build: (paths) => [binary, ...FIXED_ARGS[parse], ...paths] })
    .map((cmd) => ({ ...cmd, parse, ...extra }));
  const goModule = modulePathOf(module.root);
  if (vetArgs.length > 0) cmds.push(...goCmds('go-vet', 'types', 'go vet', context.go, vetArgs, { goModule }));
  if (found.gofmt.length > 0) {
    const gofmt = gofmtBinary(context.env, context.go);
    if (gofmt) cmds.push(...goCmds('gofmt', 'lint', 'gofmt -l', gofmt, found.gofmt.map((file) => `./${file}`)));
    else skipped.push(skip('lint', 'gofmt-not-installed', `${where}lint: gofmt: not installed`));
  }
  if (testArgs.length > 0) cmds.push(...goCmds('go-test', 'tests', 'go test', context.go, testArgs, { goModule }));
  return { skipped: [...skipped, ...notesOf(found, cmds, where)], cmds };
}
