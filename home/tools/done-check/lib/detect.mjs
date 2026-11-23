// Decides which commands the done-check runs for one change (design 3.2): per package (the nearest package.json of each changed file) a
// typecheck, a lint of the changed files and the related tests, as fixed argv commands; per Go module (the nearest go.mod of each changed
// .go file, go.mod/go.sum/go.work or Go data file) go vet, gofmt -l and go test through lib/go-plan.mjs. It runs nothing and reads no
// tool output. Go's files never reach the JS planner, so a Go-only change names no JS check; a JS-only change plans exactly as before.
// Exports: planChecks(scope, env) -> Plan.
// Invariants: scripts come from the BASE commit's package.json (`git ls-tree` + `cat-file`), the worktree copy only when there is no git
//   base or the package is new in this change (the package entry then has `fromChange: true`, an addition to the Plan type for the line).
//   A script is only ever split into plain words and matched to tsc, vitest, jest or `node --test`; anything else is named not run, never
//   run as shell text. Tools run as `node <js entry>` found in node_modules between the package and the git top (never npx, never PATH);
//   `<pm> run <fixed name>` is the only shell form and only on Windows. Besides the plan it creates only the folder for result files
//   under <HOME>/.claude/state/done-check.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_NODE_RELATED } from './contract.mjs';
import { planGoChecks } from './go-plan.mjs';
import { nodeRelatedTests, testFilesOfGlobs } from './related.mjs';
import { forwardedFlags, nodeTestGlobs, plainWords, splitScript, tscCommands } from './script-words.mjs';

const SCRIPT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue)$/;
const CODE_FILE = /(\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue)|(^|\/)\.githooks\/[^/]+)$/; // a git hook script has no extension
const FULL_SHA = /^[0-9a-f]{40}$/;
const E2E_OR_LIVE = /(^|[/._-])(e2e|live)([/._-]|$)/i;
const ARGV_LIMIT_CHARS = 28_000; // below the 32 767 characters of a Windows command line
const GIT_TIMEOUT_MS = 10_000;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const LABEL_MAX_CHARS = 80;
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]; // the order decides when two exist
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml'];
const RUNNER_CONFIGS = [['vitest', ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs']], ['jest', ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json']]];
const TOOL_ENTRIES = { tsc: ['typescript', 'bin', 'tsc'], eslint: ['eslint', 'bin', 'eslint.js'], vitest: ['vitest', 'vitest.mjs'], jest: ['jest', 'bin', 'jest.js'] };
const FORWARDED_FLAGS = { vitest: new Set(['--config', '-c', '--root', '-r', '--project', '--workspace']), jest: new Set(['--config', '-c', '--rootDir', '--selectProjects']) };
const DEFAULT_NODE_TEST_GLOBS = ['**/*.test.{js,mjs,cjs}', '**/*-test.{js,mjs,cjs}', '**/*_test.{js,mjs,cjs}', '**/test-*.{js,mjs,cjs}', '**/test.{js,mjs,cjs}', '**/test/**/*.{js,mjs,cjs}'];
const PLANNED_KINDS = ['types', 'lint', 'tests'];

const withSlashes = (path) => path.split(sep).join('/');
const shortLabel = (text) => text.replace(/[^\x20-\x7e]/g, '?').slice(0, LABEL_MAX_CHARS);
const homeOf = (env) => (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || homedir();
const hashOf = (text) => createHash('sha256').update(text).digest('hex');

// ---- reading the package ----

/** The package.json text at `base`, null when the base has none; a git failure throws (the caller names the package `error`). */
function baseFileText(top, base, file) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '-C', top, ...args], { env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: PACKAGE_JSON_MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git('ls-tree', '-z', '--name-only', base, '--', file) === '') return null;
  return git('cat-file', 'blob', `${base}:${file}`);
}

/** The scripts and package manager of one package: from the base commit, else the worktree copy (`fromChange`), else nothing. */
function readPackageJson(context, root) {
  const file = withSlashes(relative(context.top, join(root, 'package.json')));
  let text = null;
  let fromChange = false;
  try {
    if (context.git && FULL_SHA.test(context.base ?? '')) text = baseFileText(context.top, context.base, file);
    if (text === null && existsSync(join(root, 'package.json'))) {
      if (lstatSync(join(root, 'package.json')).size > PACKAGE_JSON_MAX_BYTES) return { error: 'package.json is too big' };
      text = readFileSync(join(root, 'package.json'), 'utf8');
      fromChange = true;
    }
    const parsed = text === null ? {} : JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'package.json is not an object' };
    const scripts = Object.fromEntries(Object.entries(parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {}).filter(([, value]) => typeof value === 'string'));
    return { scripts, packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : '', hasEslintConfig: Boolean(parsed.eslintConfig), fromChange };
  } catch (error) {
    return { error: error instanceof SyntaxError ? 'package.json is not valid JSON' : 'git could not read package.json at the base' };
  }
}

/** The package manager: the `packageManager` field, else the nearest lockfile up to the git top (order in LOCKFILES), else npm. */
function packageManagerOf(declared, root, top) {
  const named = declared.split('@')[0];
  if (PACKAGE_MANAGERS.has(named)) return named;
  for (let dir = root; ; dir = dirname(dir)) {
    const found = LOCKFILES.find(([lockfile]) => existsSync(join(dir, lockfile)));
    if (found) return found[1];
    if (dir === top || dirname(dir) === dir) return 'npm';
  }
}

/** The JS entry of a local tool, searched in node_modules from the package up to the git top only; null when not installed. */
function findTool(root, top, tool) {
  for (let dir = root; ; dir = dirname(dir)) {
    const entry = join(dir, 'node_modules', ...TOOL_ENTRIES[tool]);
    if (existsSync(entry)) return entry;
    if (dir === top || dirname(dir) === dir) return null;
  }
}

function hasEslintConfig(pkg, top) {
  if (pkg.hasEslintConfig) return true;
  for (let dir = pkg.root; ; dir = dirname(dir)) {
    if (ESLINT_CONFIGS.some((name) => existsSync(join(dir, name)))) return true;
    if (dir === top || dirname(dir) === dir) return false;
  }
}

// ---- building commands ----

/** A package-relative path as a command argument: never starts with `-`, so a file name cannot become a flag. */
function argPath(root, file) {
  const path = withSlashes(relative(root, file));
  return path.startsWith('-') ? `./${path}` : path;
}

/** One command per group of `files` that fits a command line; `build(files, outputFile)` gives its argv. */
function commandsFor(context, pkg, { kind, label, build, files, wantsOutput }) {
  const outputFor = () => {
    mkdirSync(join(context.stateDir, 'out'), { recursive: true });
    return join(context.stateDir, 'out', `${kind}-${randomUUID()}.json`);
  };
  const lengthOf = (argv) => argv.reduce((sum, arg) => sum + arg.length + 1, 0);
  const room = ARGV_LIMIT_CHARS - lengthOf(build([], wantsOutput ? outputFor() : undefined));
  const groups = [];
  for (const file of files) {
    const last = groups[groups.length - 1];
    if (last && last.used + file.length + 1 <= room) { last.files.push(file); last.used += file.length + 1; } else groups.push({ files: [file], used: file.length + 1 });
  }
  return (groups.length > 0 ? groups.map((group) => group.files) : [[]]).map((group) => {
    const outputFile = wantsOutput ? outputFor() : undefined;
    return { kind, argv: build(group, outputFile), cwd: pkg.root, shell: false, label, ...(outputFile ? { outputFile } : {}) };
  });
}

const skip = (kind, why, label) => ({ skipped: [{ kind, why, label }], cmds: [] });

function packageManagerRun(pkg, kind, script) {
  return { skipped: [], cmds: [{ kind, argv: [pkg.pm, 'run', script], cwd: pkg.root, shell: process.platform === 'win32', label: `${pkg.pm} run ${script}` }] };
}

function planTypes(context, pkg) {
  const script = ['typecheck', 'type-check'].find((name) => pkg.scripts[name] !== undefined);
  const commands = script ? tscCommands(pkg.scripts[script]) : existsSync(join(pkg.root, 'tsconfig.json')) ? [['-p', 'tsconfig.json']] : null;
  if (script && !commands) return packageManagerRun(pkg, 'types', script);
  if (!commands) return skip('types', 'no-command', 'types: no typecheck script and no tsconfig.json');
  const entry = findTool(pkg.root, context.top, 'tsc');
  if (!entry) return skip('types', 'no-command', 'types: typescript is not installed');
  const cmds = commands.map((args) => ({
    kind: 'types', cwd: pkg.root, shell: false, label: `tsc ${args.join(' ')}`.trim(),
    argv: [process.execPath, entry, ...args, '--noEmit', '--pretty', 'false', '--incremental', '--tsBuildInfoFile', join(context.stateDir, 'tsbuildinfo', `${hashOf(`${context.top}\0${pkg.root}\0${args.join(' ')}`).slice(0, 24)}.tsbuildinfo`)],
  }));
  return { skipped: [], cmds };
}

function planLint(context, pkg) {
  const lintable = pkg.codeFiles.filter((file) => SCRIPT_FILE.test(file));
  if (lintable.length === 0) return { skipped: [], cmds: [] };
  const entry = findTool(pkg.root, context.top, 'eslint');
  if (!entry) return skip('lint', 'no-command', 'lint: eslint is not installed');
  if (!hasEslintConfig(pkg, context.top)) return skip('lint', 'no-config', 'lint: no eslint config');
  const build = (files) => [process.execPath, entry, '--format', 'json', '--no-error-on-unmatched-pattern', ...files];
  return { skipped: [], cmds: commandsFor(context, pkg, { kind: 'lint', label: 'eslint', build, files: lintable.map((file) => argPath(pkg.root, file)) }) };
}

function plannedTestRunner(context, pkg, runner, words, label) {
  const entry = findTool(pkg.root, context.top, runner);
  if (!entry) return skip('tests', 'no-command', `tests: ${runner} is not installed`);
  if (!pkg.wide && pkg.codeFiles.length === 0) return skip('tests', 'no-related', `tests: ${label}: no changed code file`);
  const flags = forwardedFlags(words, FORWARDED_FLAGS[runner]);
  const files = pkg.wide ? [] : pkg.codeFiles.map((file) => argPath(pkg.root, file));
  const build = runner === 'vitest'
    ? (given, out) => [process.execPath, entry, ...(pkg.wide ? ['run'] : ['related', '--run']), '--reporter=json', '--outputFile', out, '--passWithNoTests', ...flags, ...given]
    : (given, out) => [process.execPath, entry, ...flags, '--json', '--outputFile', out, '--passWithNoTests', ...(pkg.wide ? [] : ['--findRelatedTests', ...given])];
  return { skipped: [], cmds: commandsFor(context, pkg, { kind: 'tests', label: runner, build, files, wantsOutput: true }) };
}

function plannedNodeTests(context, pkg, globs) {
  const used = globs.length > 0 ? globs : DEFAULT_NODE_TEST_GLOBS;
  const label = `node --test ${globs.join(' ')}`.trim();
  const picked = pkg.wide ? testFilesOfGlobs(pkg.root, used).slice(0, MAX_NODE_RELATED) : nodeRelatedTests(pkg.root, used, [...pkg.codeFiles, ...pkg.namedFiles].map((file) => withSlashes(relative(pkg.root, file))), MAX_NODE_RELATED);
  if (picked.length === 0) return skip('tests', 'no-related', `tests: ${label}: no related test file`);
  const argv = [process.execPath, '--test', '--test-reporter=tap', ...picked.map((file) => argPath(pkg.root, file))];
  return { skipped: [], cmds: [{ kind: 'tests', argv, cwd: pkg.root, shell: false, label }] };
}

/** Plans one script part: a known runner on plain words, else the part is named not run (never run as text). */
function planTestPart(context, pkg, part) {
  const label = shortLabel(part);
  const words = plainWords(part);
  const runner = words && (words[0] === 'node' ? 'node' : ['vitest', 'jest'].includes(words[0]) ? words[0] : null);
  const supported = runner && (runner === 'node' ? nodeTestGlobs(words) : !words[1] || words[1].startsWith('-') || words[1] === 'run') ? words : null;
  if (!supported) return skip('tests', 'not-supported', `tests: ${label}`);
  if (runner === 'node') return plannedNodePart(context, pkg, nodeTestGlobs(words));
  if (words.slice(1).some((word) => E2E_OR_LIVE.test(word))) return skip('tests', 'e2e-or-live', `tests: ${label}`);
  return plannedTestRunner(context, pkg, runner, words, label);
}

/** A `node --test` part: only its e2e or live globs are dropped (and named), the other globs still pick related tests. */
function plannedNodePart(context, pkg, globs) {
  const dropped = globs.filter((glob) => E2E_OR_LIVE.test(glob));
  if (dropped.length === 0) return plannedNodeTests(context, pkg, globs);
  const dropNote = skip('tests', 'e2e-or-live', `tests: ${shortLabel(`node --test ${dropped.join(' ')}`)}`);
  if (dropped.length === globs.length) return dropNote;
  const planned = plannedNodeTests(context, pkg, globs.filter((glob) => !dropped.includes(glob)));
  return { skipped: [...dropNote.skipped, ...planned.skipped], cmds: planned.cmds };
}

function planTests(context, pkg) {
  if (pkg.scripts.test === undefined) {
    const configured = RUNNER_CONFIGS.find(([, names]) => names.some((name) => existsSync(join(pkg.root, name))));
    return configured ? plannedTestRunner(context, pkg, configured[0], [configured[0]], configured[0]) : skip('tests', 'no-command', 'tests: no test script and no vitest or jest config');
  }
  const planned = splitScript(pkg.scripts.test).map((part) => planTestPart(context, pkg, part));
  return { skipped: planned.flatMap((entry) => entry.skipped), cmds: planned.flatMap((entry) => entry.cmds) };
}

const KIND_PLANNERS = { types: planTypes, lint: planLint, tests: planTests };

// ---- the plan ----

/** The package root of a changed file: its nearest folder with a package.json up to the git top, else the top. */
function packageRootOf(top, file) {
  for (let dir = dirname(resolve(top, file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === top || dirname(dir) === dir) return top;
  }
}

const isInside = (top, path) => {
  const inside = relative(top, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
};

/** One entry per package with a changed file: its root, which files changed, and whether a wide file widens its checks. */
function groupByPackage(context, scope) {
  const groups = new Map();
  const wideOwners = new Set();
  const place = (file) => {
    const abs = resolve(context.top, file);
    if (!isInside(context.top, abs)) return null; // a path that climbs out of the project is never used
    const root = packageRootOf(context.top, file);
    if (!groups.has(root)) groups.set(root, { root, codeFiles: [], namedFiles: [] });
    return { abs, root };
  };
  for (const file of scope.wide) { const placed = place(file); if (placed) wideOwners.add(placed.root); }
  for (const file of scope.files) {
    const placed = place(file);
    if (placed && CODE_FILE.test(file) && existsSync(placed.abs) && lstatSync(placed.abs).isFile()) groups.get(placed.root).codeFiles.push(placed.abs);
  }
  for (const file of scope.named ?? []) {
    const placed = place(file);
    if (placed) groups.get(placed.root).namedFiles.push(placed.abs); // a named file may be gone (deleted): a test that reads it fails
  }
  const widened = (root) => [...wideOwners].some((owner) => root === owner || root.startsWith(owner + sep));
  return [...groups.values()].sort((left, right) => (left.root < right.root ? -1 : 1)).map((group) => ({ ...group, wide: widened(group.root) }));
}

/** The command lines of a plan with the parts that differ per machine or per run (node path, go path, state folder, project path) replaced. */
function fingerprintOf(context, packages) {
  const goTools = new Set(packages.flatMap((entry) => entry.cmds.filter((cmd) => cmd.parse).map((cmd) => cmd.argv[0])));
  const stable = (arg) => (arg === process.execPath ? '<node>' : goTools.has(arg) ? `<${basename(arg)}>` : arg.startsWith(context.stateDir) ? '<state>' : arg.split(context.top).join('<top>'));
  const lines = packages.flatMap((entry) => entry.cmds.map((cmd) => JSON.stringify([cmd.kind, cmd.shell, withSlashes(relative(context.top, cmd.cwd)), cmd.argv.map(stable)])));
  return hashOf(lines.join('\n'));
}

/**
 * What to run for one change: per package a typecheck, a lint and the related tests, as argv commands (nothing is run here).
 * @param {import('./contract.mjs').Scope} scope the change: files, wide files, git top and base
 * @param {NodeJS.ProcessEnv} env the environment: HOME (state folder), PATH (where go and gofmt are found) and DONE_CHECK_SKIP (`all`
 *   or a list of types,lint,tests)
 * @returns {import('./contract.mjs').Plan} commands per package, checks that cannot run with their reason, and a fingerprint of the commands
 * @throws {Error} when the state folder for result files cannot be made
 */
export function planChecks(scope, env) {
  const stateDir = join(homeOf(env), '.claude', 'state', 'done-check');
  const context = { top: scope.top, git: scope.git, base: scope.base, stateDir };
  const asked = new Set((env.DONE_CHECK_SKIP ?? '').split(',').map((name) => name.trim()));
  const skippedByEnv = PLANNED_KINDS.filter((kind) => asked.has('all') || asked.has(kind));
  const skipped = skippedByEnv.map((kind) => ({ kind, why: 'skipped-env', label: `${kind}: DONE_CHECK_SKIP=${asked.has('all') ? 'all' : kind}` }));
  if (!scope.top || asked.has('all')) return { packages: [], skipped: scope.top ? skipped : PLANNED_KINDS.map((kind) => ({ kind, why: 'no-command', label: `${kind}: no project folder` })), fingerprint: fingerprintOf(context, []) };
  const go = planGoChecks({ top: scope.top, env, inGroups: (root, spec) => commandsFor(context, { root }, spec) }, scope);
  const packages = [];
  for (const group of groupByPackage(context, go.rest)) {
    const json = readPackageJson(context, group.root);
    const where = group.root === scope.top ? '' : `${withSlashes(relative(scope.top, group.root))}: `;
    if (json.error) { skipped.push(...PLANNED_KINDS.filter((kind) => !skippedByEnv.includes(kind)).map((kind) => ({ kind, why: 'error', label: `${where}${kind}: ${json.error}` }))); continue; }
    const pkg = { ...group, ...json, pm: packageManagerOf(json.packageManager, group.root, scope.top) };
    const cmds = [];
    const namedOnly = pkg.codeFiles.length === 0 && !pkg.wide; // only text files a test reads changed: no typecheck or lint of them
    for (const kind of PLANNED_KINDS.filter((name) => !skippedByEnv.includes(name) && (!namedOnly || name === 'tests'))) {
      const planned = KIND_PLANNERS[kind](context, pkg);
      cmds.push(...planned.cmds);
      skipped.push(...planned.skipped.map((entry) => ({ ...entry, label: `${where}${entry.label}` })));
    }
    packages.push({ root: group.root, pm: pkg.pm, cmds, ...(json.fromChange ? { fromChange: true } : {}) });
  }
  const wanted = (entry) => !skippedByEnv.includes(entry.kind);
  packages.push(...go.packages.map((entry) => ({ ...entry, cmds: entry.cmds.filter(wanted) })));
  skipped.push(...go.skipped.filter(wanted));
  const seen = new Set();
  const unique = skipped.filter((entry) => { const key = `${entry.kind}|${entry.why}|${entry.label}`; return seen.has(key) ? false : seen.add(key); });
  return { packages, skipped: unique, fingerprint: fingerprintOf(context, packages) };
}
