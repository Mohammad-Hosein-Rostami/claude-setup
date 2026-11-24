// Gap tests for home/tools/suite against its spec (team-split plan, T3): the pass cache is opt-in with `--cache` (an install or
// a build has side effects and must never be served from it), a cached pass belongs to the folder it ran in, and `related`
// treats a change of a steering doc (home/agents/*.md, home/skills/*/SKILL.md, a CLAUDE.md) as the full suite.
// Every case has its own state folder (CLAUDE_CONFIG_DIR) and its own throw-away git repo in the OS temp folder, so cases can run
// at any concurrency. The fake commands are small node scripts written into the case's temp folder, outside the repo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SUITE = fileURLToPath(new URL('../home/tools/suite/suite.mjs', import.meta.url));

// Appends one line to <marker> (so a run that happened can be counted), then exits with <code>.
const MARKER_FAKE = `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], 'ran\\n');
process.exit(Number(process.argv[3]));
`;
// Appends the folder it runs in to <marker>, so a test can see where each run happened.
const CWD_FAKE = `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], process.cwd() + '\\n');
`;
// Stands in for `npm ci`: appends to <marker> whether <holder> (the slot's holder.json) exists while it runs; creates nothing in
// the repo, so the tree stays clean and a pass would be cacheable if the tool wrongly cached it.
const INSTALL_FAKE = `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.argv[2], (existsSync(process.argv[3]) ? 'holder' : 'no holder') + '\\n');
`;

/** A fresh case: a state folder, a folder for fakes and markers, a clean git repo, and the env that points the tool at the state. */
function makeCase(files = { 'a.txt': 'a\n' }) {
  const root = realpathSync(makeTempDir('suite-gaps-')); // real path: git-tidy-helpers' git() runs only under the real temp folder
  const configDir = join(root, 'config');
  const stateDir = join(configDir, 'state', 'suite');
  const work = join(root, 'work');
  mkdirSync(work);
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const fake = (name, text) => {
    const path = join(work, name);
    writeFileSync(path, text);
    return path;
  };
  const marker = join(work, 'marker');
  const markerLines = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);
  return { stateDir, work, repo, fake, marker, markerLines, env: { ...CLEAN_ENV, CLAUDE_CONFIG_DIR: configDir } };
}

function writeFiles(repo, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
}

/** Runs the CLI and waits for it; resolves to `{ status, stdout, stderr }`. */
function suite(args, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUITE, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let [stdout, stderr] = ['', ''];
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const output = (result) => `exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;

// Guards: without --cache the pass cache is neither read nor written, so the same command on the same clean tree runs twice.
test('run without --cache runs the command every time on the same clean tree', async () => {
  const { repo, env, fake, marker, markerLines } = makeCase();
  const script = fake('marker.mjs', MARKER_FAKE);
  const run = () => suite(['run', '--repo', repo, '--', process.execPath, script, marker, '0'], { env, cwd: repo });
  const first = await run();
  assert.equal(first.status, 0, output(first));
  const second = await run();
  assert.equal(second.status, 0, output(second));
  assert.match(second.stdout, /^PASS /, `the second run without --cache must run, not be served from the cache: ${output(second)}`);
  assert.equal(markerLines().length, 2, 'the command ran on both runs');
});

// Guards: the --cache flag of the spec exists; with it a pass is stored and the same clean tree and command is a cached PASS.
test('run --cache stores a pass and serves the second run as cached PASS without running it', async () => {
  const { repo, env, fake, marker, markerLines } = makeCase();
  const script = fake('marker.mjs', MARKER_FAKE);
  const run = () => suite(['run', '--repo', repo, '--cache', '--', process.execPath, script, marker, '0'], { env, cwd: repo });
  const first = await run();
  assert.equal(first.status, 0, `--cache must be a known option: ${output(first)}`);
  assert.match(first.stdout, /^PASS /);
  const second = await run();
  assert.equal(second.status, 0, output(second));
  assert.match(second.stdout, /^cached PASS /, output(second));
  assert.equal(markerLines().length, 1, 'the cached run did not run the command');
});

/** A clean repo with two committed folders, and a runner of the cwd fake in one of them with the given flags. */
function twoFolderCase() {
  const testCase = makeCase({ 'pkgA/a.txt': 'a\n', 'pkgB/b.txt': 'b\n' });
  const script = testCase.fake('cwd.mjs', CWD_FAKE);
  const runIn = (folder, ...flags) => suite(['run', '--repo', join(testCase.repo, folder), ...flags, '--', process.execPath, script, testCase.marker], { env: testCase.env, cwd: testCase.repo });
  return { ...testCase, runIn };
}

// Guards: a pass from one folder of a tree is not reused for the same command in another folder (it runs somewhere else).
test('run --cache in another folder of the same tree runs the command there, not cached PASS', async () => {
  const { repo, runIn, markerLines } = twoFolderCase();
  const inA = await runIn('pkgA', '--cache');
  assert.equal(inA.status, 0, `--cache must be a known option: ${output(inA)}`);
  const inB = await runIn('pkgB', '--cache');
  assert.equal(inB.status, 0, output(inB));
  assert.doesNotMatch(inB.stdout, /^cached PASS /, `the pkgB run must not reuse the pkgA pass: ${output(inB)}`);
  assert.deepEqual(markerLines(), [join(repo, 'pkgA'), join(repo, 'pkgB')], 'the command ran once in each folder');
});

// Guards: without --cache, a run in a second folder of the same clean tree is never served from the first folder's pass.
test('run without --cache in another folder of the same tree runs the command there', async () => {
  const { repo, runIn, markerLines } = twoFolderCase();
  const inA = await runIn('pkgA');
  assert.equal(inA.status, 0, output(inA));
  const inB = await runIn('pkgB');
  assert.equal(inB.status, 0, output(inB));
  assert.match(inB.stdout, /^PASS /, `the pkgB run must run, not be served from the pkgA pass: ${output(inB)}`);
  assert.deepEqual(markerLines(), [join(repo, 'pkgA'), join(repo, 'pkgB')], 'the command ran once in each folder');
});

// Guards: an install-like command (stands in for `npm ci`) goes through the queue every time and is never cached.
test('an install-like command holds a queue slot on every run and is never cached', async () => {
  const { repo, env, fake, marker, markerLines, stateDir } = makeCase();
  const script = fake('install.mjs', INSTALL_FAKE);
  const holder = join(stateDir, 'slots', '0', 'holder.json');
  const run = () => suite(['run', '--repo', repo, '--slots', '1', '--', process.execPath, script, marker, holder], { env, cwd: repo });
  const first = await run();
  assert.equal(first.status, 0, output(first));
  const second = await run();
  assert.equal(second.status, 0, output(second));
  assert.match(second.stdout, /^PASS /, `the second install must run, not be served from the cache: ${output(second)}`);
  assert.deepEqual(markerLines(), ['holder', 'holder'], 'both runs ran while holding slot 0');
});

// Unrelated tests so that the one test naming the doc stays under related's 40% share (3 tests: 1 of 3 = 33%), and a `full`
// answer can come only from the steering-doc rule.
const UNRELATED_TESTS = { 'tests/a.test.mjs': "const A = 'a';\n", 'tests/b.test.mjs': "const B = 'b';\n" };
// Each steering doc, and a test that names it in a string (as a test that pins its text would).
const STEERING_DOCS = [
  { doc: 'home/agents/tess.md', namedAs: 'tess.md' },
  { doc: 'home/skills/qa-plan/SKILL.md', namedAs: 'SKILL.md' },
  { doc: 'home/CLAUDE.md', namedAs: 'CLAUDE.md' },
];
// Reads every file of home/agents without naming one, like tests/agent-files.test.mjs: a doc change can break it unseen.
const FOLDER_SCAN_TEST = "import { readdirSync } from 'node:fs';\nconst AGENTS = readdirSync(new URL('../home/agents/', import.meta.url));\n";

for (const { doc, namedAs } of STEERING_DOCS) {
  // Guards: a steering doc can break a test that scans its whole folder without naming it, so its change is the full suite.
  test(`related: a change of ${doc} selects the full suite`, async () => {
    const { repo, env } = makeCase({
      ...UNRELATED_TESTS,
      'tests/agent-files.test.mjs': FOLDER_SCAN_TEST,
      'tests/other.test.mjs': `const DOC = '${namedAs}';\n`,
      'home/agents/lex.md': '# lex\n',
      [doc]: '# doc\n',
    });
    writeFileSync(join(repo, doc), '# doc, changed\n');
    const result = await suite(['related', '--repo', repo, '--base', 'HEAD', '--tip', 'HEAD'], { env, cwd: repo });
    assert.equal(result.status, 0, output(result));
    assert.equal(result.stdout, 'full\n', `a ${doc} change must be the full suite: ${output(result)}`);
  });
}
