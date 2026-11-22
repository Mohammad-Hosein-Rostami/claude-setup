// Contract tests of the done-check's two "what to run" libs, written from the design (road newchk, sections 3.2 and 6) apart from the code:
// planChecks(scope, env) in lib/detect.mjs (which commands run for a change) and nodeRelatedTests(root, globs, files, max) in lib/related.mjs.
// Every test builds a throw-away project through tests/done-check-fixture.mjs (temp folder, temp HOME, fake tsc/eslint/vitest/jest); no
// tool runs here, only the plan is read. Red until the engine lands (step 3): the imports below fail while the modules are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { MAX_NODE_RELATED, NOT_RUN_WHY } from '../home/tools/done-check/lib/contract.mjs';
import { planChecks } from '../home/tools/done-check/lib/detect.mjs';
import { nodeRelatedTests } from '../home/tools/done-check/lib/related.mjs';
import { FAKE_TOOLS, makeDoneCheckRepo, nodeTestSource } from './done-check-fixture.mjs';

const SRC_A = 'export const a = 1;\n';
const NODE_TEST_SCRIPT = 'node --test tests/*.test.mjs';
const ARGV_LIMIT_CHARS = 30_000; // below the 32 767 characters a Windows command line may hold

/** A project that is removed when the test ends. */
function project(t, options) {
  const repo = makeDoneCheckRepo(options);
  t.after(() => repo.cleanup());
  return repo;
}
const scopeOf = (repo, files, wide = []) => ({ top: repo.dir, git: repo.baseSha !== null, base: repo.baseSha, files, wide, key: 'k' });
const planFor = (repo, files, { wide = [], env = {}, base = repo.baseSha } = {}) => planChecks({ ...scopeOf(repo, files, wide), base }, { ...repo.env, ...env });
const cmdsOf = (plan, kind) => plan.packages.flatMap((entry) => entry.cmds).filter((cmd) => cmd.kind === kind);
const skippedOf = (plan, kind) => plan.skipped.filter((entry) => entry.kind === kind);
const isNode = (program) => program === process.execPath || /^node(\.exe)?$/.test(basename(program));
const toolEntry = (repo, tool, at = '.') => join(repo.dir, at, 'node_modules', FAKE_TOOLS[tool].folder, FAKE_TOOLS[tool].entry);
const flagValue = (argv, name) => {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  return at < 0 ? undefined : argv[at].startsWith(`${name}=`) ? argv[at].slice(name.length + 1) : argv[at + 1];
};
const passes = (cmd, absoluteFile) => cmd.argv.slice(2).some((arg) => resolve(cmd.cwd, arg) === absoluteFile);
const relPath = (repo, file) => relative(repo.dir, resolve(repo.dir, file)).split(sep).join('/');
/** The `.test.mjs` files a `node --test` command was given, repo-relative. */
const testFilesOf = (repo, cmd) => cmd.argv.filter((arg) => arg.endsWith('.test.mjs')).map((arg) => relPath(repo, resolve(cmd.cwd, arg))).sort();
const nodeCmd = (plan) => cmdsOf(plan, 'tests').find((cmd) => isNode(cmd.argv[0]) && cmd.argv.includes('--test'));

// ---- types ----

test('a typecheck script of only tsc commands runs through the local typescript, no shell, cache outside the project', (t) => {
  const repo = project(t, { packageJson: { scripts: { typecheck: 'tsc -p tsconfig.json' } }, tools: ['tsc'], files: { 'tsconfig.json': '{}\n', 'src/a.ts': SRC_A } });
  const cmds = cmdsOf(planFor(repo, ['src/a.ts']), 'types');
  assert.equal(cmds.length, 1);
  const [cmd] = cmds;
  assert.ok(isNode(cmd.argv[0]));
  assert.equal(resolve(cmd.argv[1]), toolEntry(repo, 'tsc'));
  assert.equal(cmd.shell, false);
  assert.equal(cmd.cwd, repo.dir);
  assert.equal(flagValue(cmd.argv, '-p'), 'tsconfig.json');
  assert.ok(cmd.argv.includes('--noEmit') && cmd.argv.includes('--incremental'));
  assert.equal(flagValue(cmd.argv, '--pretty'), 'false');
  const buildInfo = resolve(flagValue(cmd.argv, '--tsBuildInfoFile'));
  assert.ok(buildInfo.startsWith(repo.home + sep), 'the incremental cache lives under the HOME state folder');
  assert.ok(!buildInfo.startsWith(repo.dir + sep), 'the cache must not dirty the project');
});

test('a typecheck script with two tsc commands joined by && gives one command each', (t) => {
  const repo = project(t, { packageJson: { scripts: { 'type-check': 'tsc -p tsconfig.json && tsc -p tsconfig.small.json' } }, tools: ['tsc'], files: { 'tsconfig.json': '{}\n', 'tsconfig.small.json': '{}\n', 'src/a.ts': SRC_A } });
  const cmds = cmdsOf(planFor(repo, ['src/a.ts']), 'types');
  assert.deepEqual(cmds.map((cmd) => flagValue(cmd.argv, '-p')), ['tsconfig.json', 'tsconfig.small.json']);
  assert.ok(cmds.every((cmd) => resolve(cmd.argv[1]) === toolEntry(repo, 'tsc') && cmd.shell === false));
});

test('a typecheck script with a non-tsc part runs as "<pm> run <script>", through a shell only on Windows', (t) => {
  const repo = project(t, { packageJson: { packageManager: 'pnpm@9.1.0', scripts: { typecheck: 'tsc -p tsconfig.json && node scripts/check.mjs' } }, tools: ['tsc'], files: { 'src/a.ts': SRC_A } });
  const [cmd, ...more] = cmdsOf(planFor(repo, ['src/a.ts']), 'types');
  assert.equal(more.length, 0);
  assert.deepEqual(cmd.argv.slice(-2), ['run', 'typecheck']);
  assert.equal(cmd.shell, process.platform === 'win32');
  if (process.platform !== 'win32') assert.deepEqual(cmd.argv, ['pnpm', 'run', 'typecheck']);
});

test('without a typecheck script a tsconfig and a local typescript give tsc -p tsconfig.json; without a tsconfig the check is named not run', (t) => {
  const withConfig = project(t, { packageJson: { name: 'p' }, tools: ['tsc'], files: { 'tsconfig.json': '{}\n', 'src/a.ts': SRC_A } });
  const [cmd] = cmdsOf(planFor(withConfig, ['src/a.ts']), 'types');
  assert.equal(flagValue(cmd.argv, '-p'), 'tsconfig.json');
  const noConfig = project(t, { packageJson: { name: 'p' }, tools: ['tsc'], files: { 'src/a.ts': SRC_A } });
  const plan = planFor(noConfig, ['src/a.ts']);
  assert.equal(cmdsOf(plan, 'types').length, 0);
  assert.deepEqual(skippedOf(plan, 'types').map((entry) => entry.why), ['no-command']);
});

test('binaries come from node_modules up to the git top only: a package finds the root typescript, a copy above the repo is ignored', (t) => {
  const mono = project(t, { packageJson: { name: 'root' }, tools: ['tsc'], files: { 'packages/app/package.json': '{"scripts":{"typecheck":"tsc -p tsconfig.json"}}\n', 'packages/app/tsconfig.json': '{}\n', 'packages/app/src/a.ts': SRC_A } });
  const [cmd] = cmdsOf(planFor(mono, ['packages/app/src/a.ts']), 'types');
  assert.equal(resolve(cmd.argv[1]), toolEntry(mono, 'tsc'));
  assert.equal(cmd.cwd, join(mono.dir, 'packages', 'app'));
  const outside = project(t, { packageJson: { name: 'p' }, files: { 'tsconfig.json': '{}\n', 'src/a.ts': SRC_A } });
  outside.installTools(['tsc'], '..');
  const plan = planFor(outside, ['src/a.ts']);
  assert.equal(cmdsOf(plan, 'types').length, 0);
  assert.equal(skippedOf(plan, 'types').length, 1);
});

// ---- lint ----

test('lint runs the local eslint with --format json on the changed code files of the package only', (t) => {
  const repo = project(t, { packageJson: { name: 'p' }, tools: ['eslint'], files: { 'eslint.config.mjs': 'export default [];\n', 'src/a.ts': SRC_A, 'src/b.vue': '<template/>\n', 'README.md': '# x\n' } });
  const [cmd] = cmdsOf(planFor(repo, ['src/a.ts', 'src/b.vue', 'README.md', 'package.json'], { wide: ['package.json'] }), 'lint');
  assert.equal(resolve(cmd.argv[1]), toolEntry(repo, 'eslint'));
  assert.equal(flagValue(cmd.argv, '--format'), 'json');
  assert.equal(cmd.shell, false);
  assert.ok(passes(cmd, join(repo.dir, 'src/a.ts')) && passes(cmd, join(repo.dir, 'src/b.vue')));
  assert.ok(!passes(cmd, join(repo.dir, 'README.md')) && !passes(cmd, join(repo.dir, 'package.json')));
});

test('lint with eslint but no config anywhere is named not run (no-config); a config above the package counts', (t) => {
  const none = project(t, { packageJson: { name: 'p' }, tools: ['eslint'], files: { 'src/a.ts': SRC_A } });
  assert.deepEqual(skippedOf(planFor(none, ['src/a.ts']), 'lint').map((entry) => entry.why), ['no-config']);
  const above = project(t, { packageJson: { name: 'root' }, tools: ['eslint'], files: { 'eslint.config.mjs': 'export default [];\n', 'packages/a/package.json': '{}\n', 'packages/a/src/x.ts': SRC_A, 'packages/b/package.json': '{}\n', 'packages/b/src/y.ts': SRC_A } });
  const plan = planFor(above, ['packages/a/src/x.ts', 'packages/b/src/y.ts']);
  assert.deepEqual(plan.packages.map((entry) => entry.root).sort(), [join(above.dir, 'packages/a'), join(above.dir, 'packages/b')]);
  const [lintA, lintB] = plan.packages.map((entry) => entry.cmds.find((cmd) => cmd.kind === 'lint'));
  assert.ok(lintA && lintB);
  for (const [cmd, own, other] of [[lintA, 'a/src/x.ts', 'b/src/y.ts'], [lintB, 'b/src/y.ts', 'a/src/x.ts']]) {
    assert.ok(passes(cmd, join(above.dir, 'packages', own)) && !passes(cmd, join(above.dir, 'packages', other)));
  }
});

// ---- package manager ----

test('the package manager comes from the packageManager field, else from the lockfile', (t) => {
  const cases = [['yarn@4.0.0', null, 'yarn'], [undefined, 'pnpm-lock.yaml', 'pnpm'], [undefined, 'yarn.lock', 'yarn'], [undefined, 'package-lock.json', 'npm'], [undefined, 'bun.lock', 'bun']];
  for (const [packageManager, lockfile, expected] of cases) {
    const repo = project(t, { packageJson: { packageManager, scripts: { typecheck: 'node check.mjs' } }, files: { 'src/a.ts': SRC_A, ...(lockfile ? { [lockfile]: '\n' } : {}) } });
    assert.equal(planFor(repo, ['src/a.ts']).packages[0].pm, expected, `${packageManager ?? lockfile}`);
  }
});

// ---- tests: vitest and jest ----

test('a vitest test script runs "vitest related --run" with the json reporter, an output file and the changed files', (t) => {
  const repo = project(t, { packageJson: { scripts: { test: 'vitest run' } }, tools: ['vitest'], files: { 'src/a.ts': SRC_A } });
  const [cmd] = cmdsOf(planFor(repo, ['src/a.ts', 'README.md']), 'tests');
  assert.equal(resolve(cmd.argv[1]), toolEntry(repo, 'vitest'));
  assert.ok(cmd.argv.includes('related') && cmd.argv.includes('--run') && cmd.argv.includes('--passWithNoTests'));
  assert.equal(flagValue(cmd.argv, '--reporter'), 'json');
  assert.equal(resolve(flagValue(cmd.argv, '--outputFile')), resolve(cmd.outputFile));
  assert.ok(!resolve(cmd.outputFile).startsWith(repo.dir + sep), 'the result file is outside the project');
  assert.ok(passes(cmd, join(repo.dir, 'src/a.ts')) && !passes(cmd, join(repo.dir, 'README.md')));
});

test('a jest test script runs "jest --findRelatedTests <files> --json --outputFile"', (t) => {
  const repo = project(t, { packageJson: { scripts: { test: 'jest' } }, tools: ['jest'], files: { 'src/a.ts': SRC_A } });
  const [cmd] = cmdsOf(planFor(repo, ['src/a.ts']), 'tests');
  assert.equal(resolve(cmd.argv[1]), toolEntry(repo, 'jest'));
  assert.ok(cmd.argv.includes('--findRelatedTests') && cmd.argv.includes('--json') && cmd.argv.includes('--passWithNoTests'));
  assert.equal(resolve(flagValue(cmd.argv, '--outputFile')), resolve(cmd.outputFile));
  assert.ok(passes(cmd, join(repo.dir, 'src/a.ts')));
});

test('with no test script a vitest or jest config picks that runner; with neither the check is named not run (no-command)', (t) => {
  const vitest = project(t, { packageJson: { name: 'p' }, tools: ['vitest'], files: { 'vitest.config.ts': 'export default {};\n', 'src/a.ts': SRC_A } });
  assert.ok(cmdsOf(planFor(vitest, ['src/a.ts']), 'tests')[0].argv.includes('related'));
  const jest = project(t, { packageJson: { name: 'p' }, tools: ['jest'], files: { 'jest.config.js': 'module.exports = {};\n', 'src/a.ts': SRC_A } });
  assert.ok(cmdsOf(planFor(jest, ['src/a.ts']), 'tests')[0].argv.includes('--findRelatedTests'));
  const neither = project(t, { packageJson: { name: 'p' }, tools: ['vitest'], files: { 'src/a.ts': SRC_A } });
  const plan = planFor(neither, ['src/a.ts']);
  assert.equal(cmdsOf(plan, 'tests').length, 0);
  assert.deepEqual(skippedOf(plan, 'tests').map((entry) => entry.why), ['no-command']);
});

// ---- tests: node --test ----

const nodeProject = (t, script, files = {}) => project(t, { packageJson: { scripts: { test: script } }, files: {
  'src/a.mjs': SRC_A,
  'tests/a.test.mjs': nodeTestSource({ imports: ['../src/a.mjs'] }),
  'tests/b.test.mjs': nodeTestSource({}),
  ...files,
} });

test('a node --test script runs only the test files that import a changed file, with the tap reporter and no shell', (t) => {
  const repo = nodeProject(t, NODE_TEST_SCRIPT);
  const cmd = nodeCmd(planFor(repo, ['src/a.mjs']));
  assert.deepEqual(testFilesOf(repo, cmd), ['tests/a.test.mjs']);
  assert.equal(flagValue(cmd.argv, '--test-reporter'), 'tap');
  assert.equal(cmd.shell, false);
  assert.equal(cmd.cwd, repo.dir);
});

test('a node --test script with no related test file runs nothing and is named not run (no-related), never ok', (t) => {
  const repo = nodeProject(t, NODE_TEST_SCRIPT);
  const plan = planFor(repo, ['src/unrelated.mjs']);
  assert.equal(cmdsOf(plan, 'tests').length, 0);
  assert.deepEqual(skippedOf(plan, 'tests').map((entry) => entry.why), ['no-related']);
});

test('the test script is split at && and ;: parts that are not node, vitest or jest are named not run, the others still run', (t) => {
  const repo = project(t, { packageJson: { scripts: { test: `nx run-many -t test && turbo run test; playwright test && node scripts/check.mjs && ${NODE_TEST_SCRIPT}` } }, files: { 'src/a.mjs': SRC_A, 'tests/a.test.mjs': nodeTestSource({ imports: ['../src/a.mjs'] }) } });
  const plan = planFor(repo, ['src/a.mjs']);
  assert.deepEqual(testFilesOf(repo, nodeCmd(plan)), ['tests/a.test.mjs']);
  const skipped = skippedOf(plan, 'tests');
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((entry) => entry.why === 'not-supported'));
  for (const name of ['nx', 'turbo', 'playwright', 'scripts/check.mjs']) assert.ok(skipped.some((entry) => entry.label.includes(name)), `${name} is named`);
});

test('test parts whose globs name e2e or live are not run and are named e2e-or-live', (t) => {
  const repo = nodeProject(t, `node --test tests/e2e/*.test.mjs && node --test tests/live/*.test.mjs && ${NODE_TEST_SCRIPT}`, {
    'tests/e2e/x.test.mjs': nodeTestSource({ imports: ['../../src/a.mjs'] }),
    'tests/live/x.test.mjs': nodeTestSource({ imports: ['../../src/a.mjs'] }),
  });
  const plan = planFor(repo, ['src/a.mjs']);
  assert.deepEqual(cmdsOf(plan, 'tests').flatMap((cmd) => testFilesOf(repo, cmd)), ['tests/a.test.mjs']);
  const skipped = skippedOf(plan, 'tests');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((entry) => entry.why === 'e2e-or-live'));
});

test('a wide change (package.json) runs the full test parts: vitest without "related", every test file of the node globs', (t) => {
  const repo = project(t, { packageJson: { scripts: { test: `vitest run && ${NODE_TEST_SCRIPT}` } }, tools: ['vitest'], files: { 'src/a.mjs': SRC_A, 'tests/a.test.mjs': nodeTestSource({ imports: ['../src/a.mjs'] }), 'tests/b.test.mjs': nodeTestSource({}) } });
  const plan = planFor(repo, ['package.json'], { wide: ['package.json'] });
  const vitest = cmdsOf(plan, 'tests').find((cmd) => resolve(cmd.argv[1]) === toolEntry(repo, 'vitest'));
  assert.ok(vitest && !vitest.argv.includes('related'));
  assert.deepEqual(testFilesOf(repo, nodeCmd(plan)), ['tests/a.test.mjs', 'tests/b.test.mjs']);
});

// ---- base decides, shell, size, key ----

test('a head test and typecheck script changed to "echo ok" do not change what runs: the base scripts decide', (t) => {
  const repo = project(t, { packageJson: { scripts: { test: NODE_TEST_SCRIPT, typecheck: 'tsc -p tsconfig.json' } }, tools: ['tsc'], files: { 'tsconfig.json': '{}\n', 'src/a.mjs': SRC_A, 'tests/a.test.mjs': nodeTestSource({ imports: ['../src/a.mjs'] }) } });
  const before = planFor(repo, ['src/a.mjs', 'package.json']);
  repo.write('package.json', `${JSON.stringify({ scripts: { test: 'echo ok', typecheck: 'echo ok' } })}\n`);
  repo.commit('weaken the scripts');
  const after = planFor(repo, ['src/a.mjs', 'package.json'], { wide: ['package.json'] });
  assert.deepEqual(testFilesOf(repo, nodeCmd(after)), ['tests/a.test.mjs']);
  assert.equal(cmdsOf(after, 'types').length, 1);
  assert.ok(!JSON.stringify(after).includes('echo'));
  assert.equal(after.fingerprint, before.fingerprint);
});

test('the plan fingerprint is stable for the same commands and changes when the base commands change', (t) => {
  const repo = project(t, { packageJson: { scripts: { typecheck: 'tsc -p tsconfig.json' } }, tools: ['tsc'], files: { 'tsconfig.json': '{}\n', 'src/a.ts': SRC_A } });
  const first = planFor(repo, ['src/a.ts']).fingerprint;
  assert.equal(planFor(repo, ['src/a.ts']).fingerprint, first);
  repo.write('package.json', `${JSON.stringify({ scripts: { typecheck: 'tsc -p tsconfig.json --strict' } })}\n`);
  const moved = repo.commit('change the typecheck script');
  assert.notEqual(planFor(repo, ['src/a.ts'], { base: moved }).fingerprint, first);
});

test('a package that is new in this change, and a folder with no git base, use the worktree package.json', (t) => {
  const repo = project(t, { packageJson: { name: 'root' }, files: { 'base-only.txt': 'x\n' } });
  repo.write('packages/new/package.json', `${JSON.stringify({ scripts: { test: NODE_TEST_SCRIPT } })}\n`);
  repo.write('packages/new/src/a.mjs', SRC_A);
  repo.write('packages/new/tests/a.test.mjs', nodeTestSource({ imports: ['../src/a.mjs'] }));
  const created = nodeCmd(planFor(repo, ['packages/new/src/a.mjs']));
  assert.deepEqual(testFilesOf(repo, created), ['packages/new/tests/a.test.mjs']);
  const plain = project(t, { plain: true, packageJson: { scripts: { test: NODE_TEST_SCRIPT } }, files: { 'src/a.mjs': SRC_A, 'tests/a.test.mjs': nodeTestSource({ imports: ['../src/a.mjs'] }) } });
  const plainPlan = planChecks({ top: plain.dir, git: false, base: null, files: ['src/a.mjs'], wide: [], key: 'k' }, plain.env);
  assert.deepEqual(testFilesOf(plain, nodeCmd(plainPlan)), ['tests/a.test.mjs']);
});

test('a hostile test script (command substitution, ;) never reaches a shell: only fixed argv commands are planned', (t) => {
  const script = `${NODE_TEST_SCRIPT}; touch PWNED && echo $(touch PWNED2) && vitest run $(touch PWNED3) --root ';x'`;
  const repo = nodeProject(t, script);
  repo.installTools(['vitest']);
  const plan = planFor(repo, ['src/a.mjs']);
  for (const cmd of plan.packages.flatMap((entry) => entry.cmds)) {
    assert.ok(cmd.shell === false || (process.platform === 'win32' && cmd.argv.includes('run')), 'no shell outside "<pm> run <name>" on Windows');
    assert.ok(!cmd.argv.some((arg) => /\$\(|;|PWNED|touch|npx/.test(arg)), `no hostile text in ${cmd.argv.join(' ')}`);
  }
  assert.deepEqual(testFilesOf(repo, nodeCmd(plan)), ['tests/a.test.mjs']);
  assert.ok(skippedOf(plan, 'tests').length >= 2, 'the touch and echo parts are named not run');
  assert.ok(!existsSync(join(repo.dir, 'PWNED')) && !existsSync(join(repo.dir, 'PWNED2')) && !existsSync(join(repo.dir, 'PWNED3')));
});

test('500 changed files and 300 test files: node picks at most 40, and vitest gets every file in commands that fit a command line', (t) => {
  const pad = 'd'.repeat(120);
  const srcFiles = Array.from({ length: 500 }, (_, i) => `src/gen/${pad}/m${i}.mjs`);
  const files = Object.fromEntries(srcFiles.map((file) => [file, SRC_A]));
  for (let i = 0; i < 300; i += 1) files[`tests/t${i}.test.mjs`] = nodeTestSource({ imports: [`../${srcFiles[i]}`] });
  const repo = project(t, { packageJson: { scripts: { test: `vitest run && ${NODE_TEST_SCRIPT}` } }, tools: ['vitest'], files });
  const plan = planFor(repo, srcFiles);
  assert.equal(testFilesOf(repo, nodeCmd(plan)).length, MAX_NODE_RELATED);
  const vitestCmds = cmdsOf(plan, 'tests').filter((cmd) => resolve(cmd.argv[1]) === toolEntry(repo, 'vitest'));
  assert.ok(vitestCmds.length >= 1);
  for (const cmd of vitestCmds) assert.ok(cmd.argv.reduce((sum, arg) => sum + arg.length + 1, 0) <= ARGV_LIMIT_CHARS, 'one command line stays short enough for Windows');
  const given = new Set(vitestCmds.flatMap((cmd) => cmd.argv.slice(2).map((arg) => relPath(repo, resolve(cmd.cwd, arg)))));
  assert.deepEqual(srcFiles.filter((file) => !given.has(file)), []);
});

test('DONE_CHECK_SKIP=all plans no command', (t) => {
  const repo = project(t, { packageJson: { scripts: { typecheck: 'tsc -p tsconfig.json', test: 'vitest run' } }, tools: ['tsc', 'vitest'], files: { 'tsconfig.json': '{}\n', 'src/a.ts': SRC_A } });
  const plan = planFor(repo, ['src/a.ts'], { env: { DONE_CHECK_SKIP: 'all' } });
  assert.equal(plan.packages.flatMap((entry) => entry.cmds).length, 0);
  assert.ok(plan.skipped.every((entry) => NOT_RUN_WHY.includes(entry.why)));
});

// ---- nodeRelatedTests ----

const relatedIn = (repo, globs, files, max = MAX_NODE_RELATED) => nodeRelatedTests(repo.dir, globs, files, max).map((file) => relPath(repo, file)).sort();
const PLAIN = { plain: true };

test('related: a test that imports the changed file (default or side-effect import) is picked, an unrelated one and one outside the globs are not', (t) => {
  const repo = project(t, { ...PLAIN, files: {
    'src/a.mjs': SRC_A, 'tests/one.test.mjs': "import a from '../src/a.mjs';\n", 'tests/two.test.mjs': "import '../src/a.mjs';\n",
    'tests/three.test.mjs': nodeTestSource({}), 'other/four.test.mjs': "import '../src/a.mjs';\n" } });
  assert.deepEqual(relatedIn(repo, ['tests/*.test.mjs'], ['src/a.mjs']), ['tests/one.test.mjs', 'tests/two.test.mjs']);
});

test('related: imports are followed a few levels deep but not forever', (t) => {
  const chain = (name, next) => [`lib/${name}.mjs`, next ? `import './${next}.mjs';\n` : SRC_A];
  const files = { 'tests/near.test.mjs': "import '../lib/m1.mjs';\n", 'tests/far.test.mjs': "import '../lib/n1.mjs';\n" };
  for (const [name, next] of [['m1', 'm2'], ['m2', 'changed'], ['changed', null], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'], ['n5', 'n6'], ['n6', 'changed']]) {
    const [file, text] = chain(name, next);
    files[file] = text;
  }
  const repo = project(t, { ...PLAIN, files });
  assert.deepEqual(relatedIn(repo, ['tests/*.test.mjs'], ['lib/changed.mjs']), ['tests/near.test.mjs']);
});

test('related: a test that names the changed file path (for example to spawn it) is picked; a changed test file itself is picked', (t) => {
  const repo = project(t, { ...PLAIN, files: {
    'scripts/tool.mjs': SRC_A, 'tests/spawns.test.mjs': "const SCRIPT = new URL('../scripts/tool.mjs', import.meta.url);\n", 'tests/quiet.test.mjs': nodeTestSource({}) } });
  assert.deepEqual(relatedIn(repo, ['tests/*.test.mjs'], ['scripts/tool.mjs']), ['tests/spawns.test.mjs']);
  assert.deepEqual(relatedIn(repo, ['tests/*.test.mjs'], ['tests/quiet.test.mjs']), ['tests/quiet.test.mjs']);
});

test('related: the globs support *, ** and {a,b}; a glob that matches nothing gives an empty list', (t) => {
  const imp = "import '../src/a.mjs';\n";
  const repo = project(t, { ...PLAIN, files: { 'src/a.mjs': SRC_A, 'tests/deep/x/one.test.mjs': imp.replace('..', '../../..'), 'spec/two.test.mjs': imp, 'docs/three.test.mjs': imp } });
  assert.deepEqual(relatedIn(repo, ['tests/**/*.test.mjs', '{spec,lib}/*.test.mjs'], ['src/a.mjs']), ['spec/two.test.mjs', 'tests/deep/x/one.test.mjs']);
  assert.deepEqual(relatedIn(repo, ['nothing/*.test.mjs'], ['src/a.mjs']), []);
});

test('related: at most max files come back (300 related, max 40), the same ones every time; an import cycle ends', (t) => {
  const files = { 'src/a.mjs': SRC_A, 'cyc/x.mjs': "import './y.mjs';\n", 'cyc/y.mjs': "import './x.mjs';\n", 'tests/cycle.test.mjs': "import '../cyc/x.mjs';\n" };
  for (let i = 0; i < 300; i += 1) files[`tests/t${String(i).padStart(3, '0')}.test.mjs`] = "import '../src/a.mjs';\n";
  const repo = project(t, { ...PLAIN, files });
  const picked = relatedIn(repo, ['tests/*.test.mjs'], ['src/a.mjs']);
  assert.equal(picked.length, MAX_NODE_RELATED);
  assert.deepEqual(relatedIn(repo, ['tests/*.test.mjs'], ['src/a.mjs']), picked);
  assert.ok(picked.every((file) => /^tests\/t\d{3}\.test\.mjs$/.test(file)), 'the cycle test imports no changed file');
  assert.equal(relatedIn(repo, ['tests/*.test.mjs'], ['src/a.mjs'], 5).length, 5);
  assert.deepEqual(dirname(picked[0]), 'tests');
});
