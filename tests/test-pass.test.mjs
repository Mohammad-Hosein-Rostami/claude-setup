// Tests for home/tools/test-pass: the PASS record (a command that passed on a clean tree), check, the declared full-suite command.
// Every run uses a throw-away repo and a throw-away HOME, so nothing is written to the real ~/.claude/state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ROWS, recordPass } from '../home/tools/test-pass/lib/store.mjs';
import { declaredSuite, hasPass } from '../home/tools/test-pass/test-pass.mjs';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/test-pass/test-pass.mjs', import.meta.url));
const PASS = [process.execPath, '-e', 'process.exit(0)'];
const FAIL = [process.execPath, '-e', 'process.exit(3)'];

/** A repo plus a private HOME for the state files; `run` and `check` call the CLI with that HOME. */
function setup() {
  const repo = makeRepo();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'test-pass-home-')));
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env });
  return { repo, home, env, cli, run: (...args) => cli('run', ...args), check: (...args) => cli('check', ...args) };
}

const head = (repo) => git(repo, 'rev-parse', 'HEAD');

test('a passing command on a clean tree is recorded, and check finds it by the commit', () => {
  const { repo, env, run, check } = setup();
  const result = run('--', ...PASS);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check(head(repo)).status, 0);
  assert.equal(hasPass(repo, 'HEAD', { env }), true);
});

test('check finds a record by tree: a rebased copy of the passed commit counts, a changed tree does not', () => {
  const { repo, run, check } = setup();
  run('--', ...PASS);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'same files, new commit');
  assert.equal(check('HEAD').status, 0, 'same tree, another commit');
  commit(repo, 'other.txt');
  assert.equal(check('HEAD').status, 1, 'new tree');
});

test('a failing command exits with its own code and records nothing', () => {
  const { repo, run, check } = setup();
  assert.equal(run('--', ...FAIL).status, 3);
  assert.equal(check(head(repo)).status, 1);
});

test('nothing is recorded for a tree with a tracked change or a non-ignored untracked file; an ignored file does not matter', () => {
  const { repo, run, check } = setup();
  writeFileSync(join(repo, 'base.txt'), 'edited');
  const tracked = run('--', ...PASS);
  assert.equal(tracked.status, 0);
  assert.match(tracked.stderr, /not recorded: .*uncommitted/);
  git(repo, 'checkout', '--', 'base.txt');
  writeFileSync(join(repo, 'new.txt'), 'x');
  assert.match(run('--', ...PASS).stderr, /not recorded/);
  assert.equal(check('HEAD').status, 1);
  writeFileSync(join(repo, '.gitignore'), 'new.txt\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore new.txt');
  assert.equal(run('--', ...PASS).stderr, '');
  assert.equal(check('HEAD').status, 0);
});

test('nothing is recorded when the command changes HEAD\'s tree while it runs', () => {
  const { repo, run, check } = setup();
  const script = "require('node:fs').writeFileSync('moved.txt','x');const {execFileSync}=require('node:child_process');execFileSync('git',['add','moved.txt']);execFileSync('git',['commit','-q','-m','moved']);";
  const result = run('--', process.execPath, '-e', script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /HEAD's tree changed/);
  assert.equal(check('HEAD').status, 1);
});

test('the full suite is the declared command: package.json test script first, else the CLAUDE.md Tests bullet', () => {
  const { repo } = setup();
  assert.equal(declaredSuite(repo), null);
  writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n- Tests: `node --test tests/*.test.mjs` (never bare `node --test`).\n');
  assert.equal(declaredSuite(repo), 'node --test tests/*.test.mjs');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.equal(declaredSuite(repo), 'vitest run');
});

test('run --suite runs the declared command and records a suite PASS; a related-tests PASS never satisfies --suite', () => {
  const { repo, env, run, check } = setup();
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  git(repo, 'add', 'package.json');
  git(repo, 'commit', '-q', '-m', 'declare suite');
  assert.equal(run('--', ...PASS).status, 0);
  assert.equal(check('HEAD', '--suite').status, 1, 'related-tests PASS');
  assert.equal(hasPass(repo, 'HEAD', { suite: true, env }), false);
  assert.equal(run('--suite').status, 0);
  assert.equal(check('HEAD', '--suite').status, 0);
  assert.equal(hasPass(repo, 'HEAD', { suite: true, env }), true);
});

test('a suite PASS recorded under another command than the wanted one does not count', () => {
  const { repo, env, run } = setup();
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  git(repo, 'add', 'package.json');
  git(repo, 'commit', '-q', '-m', 'declare suite');
  run('--suite');
  assert.equal(hasPass(repo, 'HEAD', { suite: true, cmd: 'node -e "process.exit(0)"', env }), true);
  assert.equal(hasPass(repo, 'HEAD', { suite: true, cmd: 'something else', env }), false);
});

test('run --suite with no declared command exits 2; with a command other than the declared one exits 2 and names the declared one', () => {
  const { repo, run } = setup();
  const none = run('--suite');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /declares no full-suite command/);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'npm-run-all lint unit' } }));
  const other = run('--suite', '--', ...PASS);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /not the declared full-suite command "npm-run-all lint unit"/);
});

test('--quiet prints one line for a pass and the output tail for a failure', () => {
  const { run } = setup();
  const passed = run('--quiet', '--', ...PASS);
  assert.match(passed.stdout, /^test-pass: .* passed in [\d.]+ s\n$/);
  const failed = run('--quiet', '--', process.execPath, '-e', "console.log('boom line');process.exit(1)");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /boom line/);
});

test('usage errors exit 2: no command, unknown flag, check without a commit or with an unknown one, a folder that is not a repo', () => {
  const { cli, run, check, repo } = setup();
  assert.equal(cli().status, 2);
  assert.equal(run().status, 2);
  assert.equal(run('--nope', '--', ...PASS).status, 2);
  assert.equal(check().status, 2);
  assert.equal(check('no-such-commit').status, 2);
  assert.equal(cli('run', '--repo', tmpdir(), '--', ...PASS).status, 2);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('the state folder is private (0700), the record file is 0600, and only the newest 200 rows stay', () => {
  const { repo, home, env, run } = setup();
  run('--', ...PASS);
  const folder = join(home, '.claude', 'state', 'test-pass');
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const [name] = readdirNames(folder);
  assert.equal(statSync(join(folder, name)).mode & 0o777, 0o600);
  for (let i = 0; i < MAX_ROWS + 5; i += 1) recordPass(repo, { tree: `tree${i}`, sha: 'x', cmd: 'c', suite: false, at: 'now', ms: 1 }, env);
  const rows = readFileSync(join(folder, name), 'utf8').trim().split('\n');
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(JSON.parse(rows.at(-1)).tree, `tree${MAX_ROWS + 4}`);
});

test('a state file that is a link is never read or written', () => {
  const { repo, home, env, run } = setup();
  run('--', ...PASS);
  const folder = join(home, '.claude', 'state', 'test-pass');
  const [name] = readdirNames(folder);
  const target = join(home, 'elsewhere.jsonl');
  writeFileSync(target, readFileSync(join(folder, name)));
  rmSync(join(folder, name));
  symlinkSync(target, join(folder, name));
  assert.equal(hasPass(repo, 'HEAD', { env }), false);
  assert.equal(recordPass(repo, { tree: 'x', sha: 'y', cmd: 'c', suite: false, at: 'now', ms: 1 }, env), false);
  assert.equal(readFileSync(target, 'utf8').includes('"tree":"x"'), false);
});

test('every worktree of a clone shares the records', () => {
  const { repo, env, run } = setup();
  run('--', ...PASS);
  const other = join(repo, '..', 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', other);
  assert.equal(hasPass(realpathSync(other), 'HEAD', { env }), true);
});

const readdirNames = (folder) => readdirSync(folder).filter((name) => name.endsWith('.jsonl'));
