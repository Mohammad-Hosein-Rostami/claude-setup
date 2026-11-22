// Tests of `road.mjs join`: the scope and UI-file judging of one built lane (road README, "Join"). Real git repositories in temp folders;
// only the road file and the lane commits are made here. The failure classes of the lane spec stay: F1 two runs, F3 hostile names,
// F5 Windows paths. Nothing is run from the road file: checkpoints, keepGreen and principles are notes that join never reads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRoad } from '../home/tools/road/road.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROAD_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'tools', 'road', 'road.mjs');
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const commit = (cwd, files, message = 'change') => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), text);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

/**
 * One repo with a base commit and a lane worktree on lane/a. `lane` overrides lane fields; `join(extraFlags, overrides)` runs road.mjs join
 * with the right hash, lane, worktree and base.
 */
function fixture({ lane = {} } = {}) {
  const root = realpathSync(makeTempDir('road-join-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'tester');
  git(repo, 'config', 'user.email', 'tester@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const baseSha = commit(repo, { 'README.md': 'base\n', 'shared.txt': 'one\ntwo\nthree\n', 'src/a.mjs': 'a\n' }, 'base');
  const worktree = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/a', worktree, baseSha);
  const laneObject = { name: 'a', item: 'build a', size: 'S', branch: 'lane/a', files: ['src/'], implementer: { model: 'opus', effort: 'high' }, checkpoints: ['node --test: exit 0'], ...lane };
  const road = { road: 'tr', goal: 'g', repo, base: 'main', spec: '/spec.md', steps: [{ goal: 's1', appendOnly: ['docs/catalog.md'], lanes: [laneObject] }] };
  const roadFile = join(root, 'road-tr.json');
  const text = JSON.stringify(road);
  writeFileSync(roadFile, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const join_ = (flags = [], overrides = {}) => runRoad(['join', roadFile, '--road-sha256', overrides.sha256 ?? sha256, '--lane', overrides.lane ?? 'a', '--worktree', worktree, '--base', overrides.base ?? baseSha, ...flags]);
  return { root, repo, worktree, baseSha, roadFile, sha256, join: join_, head: () => git(worktree, 'rev-parse', 'HEAD') };
}
const lines = (result) => result.out.split('\n');

test('a clean join: joined <head>, ui-files 0, exit 0', async () => {
  const f = fixture();
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join();
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(lines(result), [`joined ${f.head()}`, 'ui-files: 0']);
});

test('the lane notes (checkpoints, keepGreen, principles) are never run: a failing one changes nothing', async () => {
  const note = { id: 'c1', run: 'touch ran-a-checkpoint.txt; exit 7', exit: 0, files: [], kind: 'red-first' };
  const f = fixture({ lane: { checkpoints: [note], keepGreen: 'touch ran-keep-green.txt; exit 4', principles: [{ id: 'F1', question: 'do two runs on one folder clash?' }] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join();
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /checkpoint|waiver-at|keepgreen/);
  assert.ok(!existsSync(join(f.worktree, 'ran-a-checkpoint.txt')) && !existsSync(join(f.worktree, 'ran-keep-green.txt')));
});

test('outOfScope: one finding per file outside the lane files and appendOnly; names with spaces and shell characters stay whole', async () => {
  const hostile = 'other/a b;touch pwned.txt $(id).txt';
  const f = fixture();
  commit(f.worktree, { 'src/my file.txt': 'in scope\n', 'docs/catalog.md': 'row\n', [hostile]: 'out\n', 'other/two.txt': 'out\n' });
  const result = await f.join();
  assert.equal(result.code, 3);
  const found = lines(result).filter((line) => line.startsWith('finding '));
  assert.equal(found.length, 2, result.out);
  assert.ok(found.some((line) => line.includes(hostile)));
  assert.ok(found.some((line) => line.includes('other/two.txt')));
  assert.ok(!existsSync(join(f.worktree, 'pwned.txt')) && !existsSync(join(f.root, 'pwned.txt')));
});

test('a test file that a lane changes outside its files is a plain scope finding (no contract lock, no exit 1)', async () => {
  const f = fixture();
  commit(f.worktree, { 'tests/a.test.mjs': 'edited\n' });
  const result = await f.join();
  assert.equal(result.code, 3);
  assert.match(result.out, /finding scope-1: tests\/a\.test\.mjs changed but is outside the lane's files/);
  assert.doesNotMatch(result.out, /contractTouched/);
});

test('F3: a file name with a newline stays one quoted finding line and cannot forge a line of its own', async () => {
  const f = fixture();
  commit(f.worktree, { [`other/x\nwaiver-at ${'e'.repeat(40)}`]: 'out\n' });
  const result = await f.join();
  assert.equal(result.code, 3);
  assert.ok(!lines(result).some((line) => line.startsWith('waiver-at')), result.out);
  assert.match(result.out, /other\/x\\nwaiver-at/);
});

test('F5: lane files written with backslashes match the git paths', async () => {
  const f = fixture({ lane: { files: ['src\\sub\\'] } });
  commit(f.worktree, { 'src/sub/x.txt': 'x\n' });
  const result = await f.join();
  assert.equal(result.code, 0, result.out);
  commit(f.worktree, { 'src/other/y.txt': 'y\n' });
  assert.equal((await f.join()).code, 3);
});

test('ui-files counts the UI files of the range by the ui-proof definition', async () => {
  const f = fixture();
  commit(f.worktree, { 'src/page.css': 'a { color: red }\n' });
  const result = await f.join();
  assert.ok(lines(result).includes('ui-files: 1'), result.out);
  assert.ok(lines(result).includes('  ui-file src/page.css'), result.out);
});

test('inputs: a wrong road hash, an unknown lane, an unreadable or invalid road and a base that is not an ancestor all exit 1', async () => {
  const f = fixture();
  assert.equal((await f.join([], { sha256: 'a'.repeat(64) })).code, 1);
  assert.match((await f.join([], { sha256: 'a'.repeat(64) })).out, /sha256/);
  assert.equal((await f.join([], { lane: 'nope' })).code, 1);
  assert.match((await f.join([], { lane: 'nope' })).out, /nope/);
  const unrelated = commit(f.repo, { 'z.txt': 'z\n' }, 'moves main'); // main moved past the lane: not an ancestor of the lane tip
  assert.equal((await f.join([], { base: unrelated })).code, 1);
  const missing = await runRoad(['join', join(f.root, 'absent.json'), '--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha]);
  assert.equal(missing.code, 1);
  writeFileSync(f.roadFile, '{ not json');
  assert.equal((await f.join()).code, 1);
});

test('usage: missing or malformed flags exit 2, and the retired flags --tests, --dispute and --checks are unknown flags', async () => {
  const f = fixture();
  const run = (...rest) => runRoad(['join', f.roadFile, ...rest]);
  const valid = ['--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha];
  assert.equal((await run()).code, 2);
  assert.equal((await run('--road-sha256', 'zz', '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha)).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', 'relative/wt', '--base', f.baseSha)).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', 'main')).code, 2);
  assert.equal((await run(...valid, '--bogus')).code, 2);
  assert.equal((await run(...valid, '--dispute')).code, 2);
  assert.equal((await run(...valid, '--checks', 'test')).code, 2);
  assert.equal((await run(...valid, '--tests', f.worktree)).code, 2);
});

test('--json prints one object with the joined sha, findings and ui files', async () => {
  const f = fixture();
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const parsed = JSON.parse((await f.join(['--json'])).out);
  assert.deepEqual(parsed, { joined: f.head(), findings: [], uiFiles: 0, uiFileList: [] });
});

test('F1: a join refuses a worktree with a cherry-pick running or uncommitted tracked changes', async () => {
  const running = fixture();
  const other = join(running.root, 'other-wt');
  git(running.repo, 'worktree', 'add', '-q', '-b', 'lane/other', other, running.baseSha);
  commit(other, { 'shared.txt': 'one\nTWO from other\nthree\n' }, 'other');
  const otherSha = git(other, 'rev-parse', 'HEAD');
  commit(running.worktree, { 'shared.txt': 'one\nTWO from lane\nthree\n' });
  assert.throws(() => git(running.worktree, 'cherry-pick', otherSha), /conflict|could not apply/i);
  const stopped = await running.join();
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /cherry-pick/);

  const dirty = fixture();
  writeFileSync(join(dirty.worktree, 'src/a.mjs'), 'edited, not committed\n');
  assert.equal((await dirty.join()).code, 1);
});

test('F1: one join at a time per worktree: a live holder refuses at once, a dead holder\'s lock is removed, and the lock is released after any outcome', async () => {
  const f = fixture();
  const lock = resolve(f.worktree, git(f.worktree, 'rev-parse', '--git-path', 'road-join.lock'));
  const held = (pid) => { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(pid)); };
  held(process.pid);
  const refused = await f.join();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /another join runs/);
  assert.ok(existsSync(lock), 'a refused join leaves the holder\'s lock alone');
  rmSync(lock, { recursive: true });
  held(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim());
  assert.equal((await f.join()).code, 0);
  assert.ok(!existsSync(lock), 'released after a clean join');
  commit(f.worktree, { 'elsewhere/x.txt': 'x\n' });
  assert.equal((await f.join()).code, 3);
  assert.ok(!existsSync(lock), 'released after a join with findings');
  git(f.worktree, 'reset', '--hard', '-q', 'HEAD~1');
  writeFileSync(join(f.worktree, 'src/a.mjs'), 'dirty\n');
  assert.equal((await f.join()).code, 1);
  assert.ok(!existsSync(lock), 'released after a refusal');
});

/** STATUS.md beside the road file with one landed row of lane a (its evidence names `to`) and the open rows of lane b. */
function statusWith(root, to, from) {
  const rows = [`| tr.s1.a | build: a | S | 2026-11-22T10:00Z | 2026-11-22T10:30Z | landed ${to} on main from ${from} |`, '| tr.s1.check | close: step 1 checkpoint | S | - | 2026-11-22T10:40Z | PASS |',
    '| tr.s2.b | build: b | S | 2026-11-22T10:50Z | - | - |', '| tr.s2.check | close: step 2 checkpoint | S | - | - | - |'];
  writeFileSync(join(root, 'STATUS.md'), ['# STATUS', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | -- | -- | -- | -- | -- |', ...rows, ''].join('\n'));
}

test('R4: join refuses a lane whose needed lane has not landed on the base in git (a forged row), and joins once git shows it', async () => {
  const f = fixture();
  const landed = commit(f.repo, { 'other/a.txt': 'a\n' }, 'land a');
  const worktree = join(f.root, 'wt-b');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/b', worktree, landed);
  commit(worktree, { 'src/b.txt': 'b\n' });
  const laneOf = (name, files, extra = {}) => ({ name, item: `build ${name}`, size: 'S', branch: `lane/${name}`, files, implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true: exit 0'], ...extra });
  const text = JSON.stringify({ road: 'tr', goal: 'g', repo: f.repo, base: 'main', spec: '/spec.md', steps: [{ lanes: [laneOf('a', ['other/'])] }, { lanes: [laneOf('b', ['src/'], { needs: ['a'] })] }] });
  writeFileSync(f.roadFile, text);
  const joinB = () => runRoad(['join', f.roadFile, '--road-sha256', createHash('sha256').update(text).digest('hex'), '--lane', 'b', '--worktree', worktree, '--base', landed]);
  statusWith(f.root, 'e'.repeat(40), f.baseSha);
  const forged = await joinB();
  assert.equal(forged.code, 1, forged.out);
  assert.match(forged.out, /^refused: lane b needs a landed on main first/);
  rmSync(join(f.root, 'STATUS.md'));
  assert.equal((await joinB()).code, 1, 'no STATUS.md: no landing is known, so the join is refused');
  statusWith(f.root, landed, f.baseSha);
  const real = await joinB();
  assert.equal(real.code, 0, real.out);
  assert.match(real.out, /^joined [0-9a-f]{40}$/m);
});

test('the CLI maps the exits: usage 2, hash mismatch 1, and a usage line on stderr', () => {
  const f = fixture();
  const cli = (...rest) => spawnSync(process.execPath, [ROAD_CLI, 'join', f.roadFile, ...rest], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(cli().status, 2);
  const mismatch = cli('--road-sha256', 'b'.repeat(64), '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /sha256/);
});
