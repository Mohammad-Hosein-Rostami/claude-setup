// Tests for scripts/affected-tests.mjs: the test map (buildMap), the decision (affected) and the CLI (--staged, --base, paths).
// The map and the decision run on small throw-away trees; the CLI runs a copy of the script inside a throw-away git repo.
// One test reads the real repo: every code file under home/ must map to a test or force the full suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affected, buildMap } from '../scripts/affected-tests.mjs';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/affected-tests.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const PASSING = "import test from 'node:test';\ntest('ok', () => {});\n";

/** Writes `files` ({ 'rel/path': text }) under a new temp folder and returns the folder. */
function makeTree(files) {
  const root = realpathSync(makeTempDir('affected-'));
  addFiles(root, files);
  return root;
}

function addFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const mapOf = (files) => buildMap(makeTree(files));

test('buildMap maps a source file to the tests that import it, directly or through another file', () => {
  const map = mapOf({
    'home/hooks/a.mjs': "import './lib/b.mjs';\n",
    'home/hooks/lib/b.mjs': 'export const b = 1;\n',
    'home/hooks/unused.mjs': 'export const u = 1;\n',
    'tests/a.test.mjs': "import '../home/hooks/a.mjs';\n",
    'tests/other.test.mjs': PASSING,
  });
  assert.deepEqual(map.tests, ['tests/a.test.mjs', 'tests/other.test.mjs']);
  assert.deepEqual(map.testsOf.get('home/hooks/lib/b.mjs'), ['tests/a.test.mjs']);
  assert.deepEqual(map.testsOf.get('home/hooks/unused.mjs') ?? [], []);
});

test('buildMap follows a script a test spawns by path string, also through a test helper', () => {
  const map = mapOf({
    'home/tools/x/x.mjs': "import './lib/y.mjs';\n",
    'home/tools/x/lib/y.mjs': 'export const y = 1;\n',
    'home/hooks/spawner.mjs': "const child = 'lib/z.mjs';\n",
    'home/hooks/lib/z.mjs': 'export const z = 1;\n',
    'tests/x-helpers.mjs': "export const CLI = new URL('../home/tools/x/x.mjs', import.meta.url);\n",
    'tests/x.test.mjs': "import { CLI } from './x-helpers.mjs';\n",
    'tests/spawn.test.mjs': "const hook = join(root, 'hooks', 'spawner.mjs');\n",
  });
  assert.deepEqual(map.testsOf.get('home/tools/x/lib/y.mjs'), ['tests/x.test.mjs']);
  assert.deepEqual(map.testsOf.get('home/hooks/lib/z.mjs'), ['tests/spawn.test.mjs']);
  assert.deepEqual(map.testsOf.get('tests/x-helpers.mjs'), ['tests/x.test.mjs']);
});

test('buildMap maps an extension-less launcher a test names in quotes', () => {
  const map = mapOf({ 'home/bin/ccm': '#!/bin/sh\n', 'tests/ccm.test.mjs': "const bin = join(HOME, 'bin', 'ccm');\n" });
  assert.deepEqual(map.testsOf.get('home/bin/ccm'), ['tests/ccm.test.mjs']);
});

const smallMap = () =>
  mapOf({
    'home/hooks/a.mjs': 'export const a = 1;\n',
    'home/hooks/orphan.mjs': 'export const o = 1;\n',
    'tests/a.test.mjs': "import '../home/hooks/a.mjs';\n",
    'tests/b.test.mjs': PASSING,
    'tests/modes-consistency.test.mjs': PASSING,
    'tests/rules-text.test.mjs': PASSING,
    'tests/helper.mjs': 'export const h = 1;\n',
    'tests/uses-helper.test.mjs': "import './helper.mjs';\n",
  });

test('affected: a change that only touches documents runs no test', () => {
  const result = affected(['docs/how-it-works.md', 'README.md', 'home/tools/x/README.md', 'home/standards/testing.md', 'home/project-notes/a.md'], smallMap(), { onBase: false });
  assert.deepEqual(result, { full: false, reason: 'no code or text file that a test reads changed', tests: [] });
});

test('affected: the document a test reads runs that test, any other document still runs nothing', () => {
  const map = mapOf({ 'tests/modes-consistency.test.mjs': PASSING, 'tests/watch-idle-cli.test.mjs': PASSING, 'tests/b.test.mjs': PASSING });
  assert.deepEqual(affected(['docs/daily-use.md'], map, { onBase: false }).tests, ['tests/modes-consistency.test.mjs', 'tests/watch-idle-cli.test.mjs']);
  assert.deepEqual(affected(['docs/catalog.md'], map, { onBase: false }).tests, []);
});

test('affected: a changed test runs itself, a changed helper runs the tests that import it, a deleted test is ignored', () => {
  const map = smallMap();
  assert.deepEqual(affected(['tests/b.test.mjs'], map, { onBase: false }).tests, ['tests/b.test.mjs']);
  assert.deepEqual(affected(['tests/helper.mjs'], map, { onBase: false }).tests, ['tests/uses-helper.test.mjs']);
  assert.deepEqual(affected(['tests/gone.test.mjs'], map, { onBase: false }), { full: false, reason: 'no code or text file that a test reads changed', tests: [] });
});

test('affected: a source file runs the tests that reach it; several changes give one sorted list without repeats', () => {
  const result = affected(['home/hooks/a.mjs', 'tests/b.test.mjs', 'tests/a.test.mjs'], smallMap(), { onBase: false });
  assert.equal(result.full, false);
  assert.deepEqual(result.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
});

test('affected: on main or master the whole suite runs', () => {
  const map = smallMap();
  const result = affected(['docs/a.md'], map, { onBase: true });
  assert.equal(result.full, true);
  assert.match(result.reason, /main or master/);
  assert.deepEqual(result.tests, map.tests);
});

test('affected: a change in .githooks, settings or the script itself runs the whole suite', () => {
  const map = smallMap();
  for (const path of ['.githooks/pre-commit', 'settings/base.json', 'scripts/affected-tests.mjs']) {
    const result = affected([path], map, { onBase: false });
    assert.equal(result.full, true, path);
    assert.deepEqual(result.tests, map.tests, path);
  }
});

test('affected: a code file or anything under home/ that no test reaches runs the whole suite', () => {
  const map = smallMap();
  for (const path of ['home/hooks/orphan.mjs', 'home/hooks/new-hook.mjs', 'scripts/new.sh', 'home/bin/newcmd', 'home/odd.json', 'home/hooks/gone.mjs']) {
    const result = affected([path], map, { onBase: false });
    assert.equal(result.full, true, path);
    assert.match(result.reason, /no test reaches/, path);
  }
});

test('affected: a map that could not be built runs the whole suite', () => {
  const result = affected(['docs/a.md'], null, { onBase: false });
  assert.deepEqual(result, { full: true, reason: 'the test map could not be built', tests: [] });
});

test('affected: lead rules, rules, agents and skills text runs the tests that read it, as far as they exist', () => {
  const map = smallMap();
  assert.deepEqual(affected(['home/lead-rules.md'], map, { onBase: false }).tests, ['tests/modes-consistency.test.mjs']);
  assert.deepEqual(affected(['home/rules/core.md'], map, { onBase: false }).tests, ['tests/modes-consistency.test.mjs', 'tests/rules-text.test.mjs']);
});

/** A repo on branch `feat` (so it is not the base) holding a copy of the script, a source file, its test and an unrelated test. */
function makeCliRepo() {
  const repo = makeRepo();
  addFiles(repo, {
    'home/hooks/a.mjs': 'export const a = 1;\n',
    'home/hooks/b.mjs': 'export const b = 1;\n',
    'tests/a.test.mjs': PASSING + "import '../home/hooks/a.mjs';\n",
    'tests/b.test.mjs': PASSING + "import '../home/hooks/b.mjs';\n",
  });
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(SCRIPT, join(repo, 'scripts', 'affected-tests.mjs'));
  mkdirSync(join(repo, 'home/tools/disk-free'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../home/tools/disk-free/with-run-tmp.mjs', import.meta.url)), join(repo, 'home/tools/disk-free/with-run-tmp.mjs'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'switch', '-q', '-c', 'feat');
  return repo;
}

// NODE_TEST_CONTEXT would make the inner `node --test` report to this test run and always exit 0.
const { NODE_TEST_CONTEXT: _outerRunner, ...OUTSIDE_A_TEST_RUN } = CLEAN_ENV;
const cli = (repo, args, env = {}) =>
  spawnSync(process.execPath, [join(repo, 'scripts', 'affected-tests.mjs'), ...args], { cwd: repo, encoding: 'utf8', env: { ...OUTSIDE_A_TEST_RUN, ...env } });

test('CLI --staged --list prints the tests of the staged files only, the reason goes to stderr', () => {
  const repo = makeCliRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'home/hooks/b.mjs'), 'export const b = 2;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  const result = cli(repo, ['--staged', '--list']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'tests/a.test.mjs\n');
  assert.match(result.stderr, /affected tests: 1 of 2/);
});

test('CLI --staged on a partial commit (a temporary index) lists only that path\'s tests', () => {
  const repo = makeCliRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'home/hooks/b.mjs'), 'export const b = 2;\n');
  git(repo, 'add', '.');
  const tempIndex = join(repo, '.git', 'partial-index');
  const withIndex = { GIT_INDEX_FILE: tempIndex };
  spawnSync('git', ['read-tree', 'HEAD'], { cwd: repo, env: { ...CLEAN_ENV, ...withIndex } });
  spawnSync('git', ['add', '--', 'home/hooks/b.mjs'], { cwd: repo, env: { ...CLEAN_ENV, ...withIndex } });
  assert.equal(cli(repo, ['--staged', '--list'], withIndex).stdout, 'tests/b.test.mjs\n');
});

test('CLI --staged --list with nothing staged prints nothing and says there is no affected test', () => {
  const result = cli(makeCliRepo(), ['--staged', '--list']);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no affected tests/);
});

test('CLI --base counts commits, uncommitted edits and new untracked files since the merge-base', () => {
  const repo = makeCliRepo();
  commit(repo, 'home/hooks/a.mjs', 'export const a = 3;\n');
  writeFileSync(join(repo, 'home/hooks/b.mjs'), 'export const b = 4;\n');
  writeFileSync(join(repo, 'tests/c.test.mjs'), PASSING);
  assert.equal(cli(repo, ['--base', 'main', '--list']).stdout, 'tests/a.test.mjs\ntests/b.test.mjs\ntests/c.test.mjs\n');
});

test('CLI with explicit paths and --why names the path behind each test', () => {
  const result = cli(makeCliRepo(), ['home/hooks/a.mjs', '--list', '--why']);
  assert.equal(result.stdout, 'tests/a.test.mjs\n');
  assert.match(result.stderr, /home\/hooks\/a\.mjs -> tests\/a\.test\.mjs/);
});

test('CLI on main runs the whole suite', () => {
  const repo = makeCliRepo();
  git(repo, 'switch', '-q', 'main');
  const result = cli(repo, ['docs/readme.md', '--list']);
  assert.equal(result.stdout, 'tests/a.test.mjs\ntests/b.test.mjs\n');
  assert.match(result.stderr, /full suite: .*main or master/);
});

test('CLI --run exits with the exit code of the tests', () => {
  const repo = makeCliRepo();
  assert.equal(cli(repo, ['home/hooks/a.mjs', '--run']).status, 0);
  writeFileSync(join(repo, 'tests/a.test.mjs'), "import test from 'node:test';\nimport '../home/hooks/a.mjs';\ntest('red', () => { throw new Error('red'); });\n");
  assert.notEqual(cli(repo, ['home/hooks/a.mjs', '--run']).status, 0);
});

test('CLI refuses a missing mode, a missing action and a test path with a space (exit 2)', () => {
  const repo = makeCliRepo();
  addFiles(repo, { 'tests/has space.test.mjs': PASSING });
  assert.equal(cli(repo, ['--list']).status, 2);
  assert.equal(cli(repo, ['--staged']).status, 2);
  assert.equal(cli(repo, ['--staged', '--base', 'main', '--list']).status, 2);
  const spaced = cli(repo, ['tests/has space.test.mjs', '--list']);
  assert.equal(spaced.status, 2);
  assert.match(spaced.stderr, /space/);
});

const codeFilesUnder = (folder) =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return codeFilesUnder(path);
    return /\.(?:mjs|cjs|js|sh|ps1|jq)$/.test(entry.name) || folder.endsWith(join('home', 'bin')) ? [path] : [];
  });

test('the real repo: every code file under home/ maps to at least one test or forces the full suite', () => {
  const map = buildMap(REPO);
  const unmapped = [];
  for (const file of codeFilesUnder(join(REPO, 'home')).map((path) => relative(REPO, path).split('\\').join('/'))) {
    const result = affected([file], map, { onBase: false });
    if (!result.full && result.tests.length === 0) unmapped.push(file);
  }
  assert.deepEqual(unmapped, []);
  assert.ok(statSync(join(REPO, 'tests')).isDirectory());
});

test('the real repo: a git-tidy library file reaches the git-tidy tests through the helper that names the CLI by path', () => {
  const result = affected(['home/tools/git-tidy/lib/branches.mjs'], buildMap(REPO), { onBase: false });
  assert.equal(result.full, false);
  assert.ok(result.tests.includes('tests/git-tidy-prune.test.mjs'), result.tests.join(' '));
});
