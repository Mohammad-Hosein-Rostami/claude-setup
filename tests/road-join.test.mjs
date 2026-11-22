// Tests of `road.mjs join` (plan.md C5): the contract judging that join.js did through a runner, now one tool. Real git repositories in temp
// folders and real `sh -c` checkpoints; only the road file, the lane and the test-writer commits are made here. Ported from the workflow
// cases (overlap, checkpoint lock, verdict, waiver) plus the failure classes of the lane spec (F1 two runs, F2 crash, F3 hostile names,
// F4 no checkpoints, F5 Windows paths).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRoad } from '../home/tools/road/road.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

// "test off" must mean off here whatever the machine's /check switch says: the switch is read from $HOME and the session id of the run.
process.env.HOME = makeTempDir('road-join-home-');
process.env.USERPROFILE = process.env.HOME;
delete process.env.CLAUDE_CODE_SESSION_ID;
const ROAD_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'tools', 'road', 'road.mjs');
const THREAT = 'single owner on his own machines; agents are semi-trusted; every gate input is hash-checked';
const PRINCIPLES = [{ id: 'F1', question: 'do two runs on one folder clash?' }];
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const TEST_FILE = 'tests/a.test.mjs';
const RED_FIRST = { id: 'feat', run: `test -f ${TEST_FILE} && test -f src/feature.txt`, exit: 0, files: [TEST_FILE], kind: 'red-first' };
const KEEPS = { id: 'keep', run: `test -f ${TEST_FILE}`, exit: 0, files: [TEST_FILE], kind: 'keeps-working' };

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
 * One repo with a base commit, a lane worktree on lane/a, and (with `withTests`) a test-writer worktree on lane/a--tests that committed TEST_FILE.
 * `road` is the road object (lane fields overridable); `join(extraFlags)` runs road.mjs join with the right hash, lane, worktree and base.
 */
function fixture({ lane = {}, step = {}, withTests = false, base = {} } = {}) {
  const root = realpathSync(makeTempDir('road-join-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'tester');
  git(repo, 'config', 'user.email', 'tester@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const baseSha = commit(repo, { 'README.md': 'base\n', 'shared.txt': 'one\ntwo\nthree\n', 'src/a.mjs': 'a\n', ...base }, 'base');
  const worktree = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/a', worktree, baseSha);
  let testsTree;
  if (withTests) {
    testsTree = join(root, 'tests-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'lane/a--tests', testsTree, baseSha);
    commit(testsTree, { [TEST_FILE]: 'test\n' }, 'tests');
  }
  const laneObject = { name: 'a', item: 'build a', size: 'S', branch: 'lane/a', files: ['src/'], acceptanceTests: withTests, implementer: { model: 'opus', effort: 'high' }, principles: PRINCIPLES, ...lane };
  const road = { road: 'tr', goal: 'g', repo, base: 'main', suite: 'npm test', spec: '/spec.md', threatModel: THREAT, steps: [{ goal: 's1', appendOnly: ['docs/catalog.md'], lanes: [laneObject], ...step }] };
  const roadFile = join(root, 'road-tr.json');
  const text = JSON.stringify(road);
  writeFileSync(roadFile, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const join_ = (flags = [], overrides = {}) => runRoad(['join', roadFile, '--road-sha256', overrides.sha256 ?? sha256, '--lane', overrides.lane ?? 'a', '--worktree', worktree, '--base', overrides.base ?? baseSha,
    ...(withTests && !overrides.noTests ? ['--tests', testsTree] : []), ...flags]);
  return { root, repo, worktree, testsTree, baseSha, roadFile, sha256, join: join_, head: () => git(worktree, 'rev-parse', 'HEAD') };
}
const ON = ['--checks', 'test'];
const lines = (result) => result.out.split('\n');

test('a clean join with tests and a red-first checkpoint: joined, ui-files, checkpoint lines, waiver-at the joined sha, exit 0', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [RED_FIRST, KEEPS] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 0, result.out);
  assert.equal(lines(result)[0], `joined ${f.head()}`);
  assert.ok(lines(result).includes('ui-files: 0'));
  assert.ok(lines(result).includes(`waiver-at ${f.head()}`));
  assert.equal(readFileSync(join(f.worktree, TEST_FILE), 'utf8'), 'test\n', 'the test-writer commit was cherry-picked');
  assert.match(result.out, /checkpoint feat: red-first base 1 head 0 met/);
  assert.match(result.out, /checkpoint keep: keeps-working base 0 head 0 met/, 'the checkpoint file was checked out from the joined sha at base');
});

test('test off: checkpoints are not run, the line says so, and waiver-at is never printed', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [RED_FIRST] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join();
  assert.equal(result.code, 0, result.out);
  assert.ok(lines(result).includes('checkpoints: not checked (test off)'));
  assert.doesNotMatch(result.out, /waiver-at/);
});

test('a lane commit that edits a checkpoint file exits 1 contractTouched and judges nothing', async () => {
  const f = fixture({ lane: { checkpoints: [{ ...KEEPS, files: ['tests/locked.test.mjs'] }] }, base: { 'tests/locked.test.mjs': 'locked\n' } });
  const tip = commit(f.worktree, { 'tests/locked.test.mjs': 'edited\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 1);
  assert.match(result.out, /contractTouched/);
  assert.match(result.out, /tests\/locked\.test\.mjs/);
  assert.doesNotMatch(result.out, /^joined |waiver-at|^checkpoint /m);
  assert.equal(f.head(), tip);
});

test('a lane commit that edits a test-writer file exits 1 contractTouched, and a lane that only has the picked tests does not (re-join)', async () => {
  const f = fixture({ withTests: true });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  assert.equal((await f.join(ON)).code, 0);
  assert.equal((await f.join(ON)).code, 0, 'a second join finds the test commits already in the lane and judges the lane commits only');
  commit(f.worktree, { [TEST_FILE]: 'edited by the implementer\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 1);
  assert.match(result.out, /contractTouched.*tests\/a\.test\.mjs/);
});

test('a red-first checkpoint that passes at base prints vacuous, is a finding, exit 3, and no waiver', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [{ ...RED_FIRST, id: 'always', run: 'true' }] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 3);
  assert.ok(lines(result).includes('vacuous always'));
  assert.match(result.out, /finding \S+: .*always/);
  assert.doesNotMatch(result.out, /waiver-at/);
});

test('a checkpoint that fails at head is a finding that carries the last output lines (at most 20)', async () => {
  const run = 'for i in $(seq 30); do echo out-$i; done; exit 7';
  const f = fixture({ lane: { checkpoints: [{ ...KEEPS, files: [], run, exit: 0 }] } });
  const result = await f.join(ON);
  assert.equal(result.code, 3);
  assert.match(result.out, /exits 7 at the joined head, not 0/);
  assert.match(result.out, /out-30/);
  assert.match(result.out, /out-11/);
  assert.doesNotMatch(result.out, /out-10\b/);
});

test('a keeps-working checkpoint that fails at base is a finding; a non-zero declared exit is met when equal', async () => {
  const f = fixture({ lane: { checkpoints: [{ ...KEEPS, files: [], id: 'later', run: 'test -f src/feature.txt' }, { ...KEEPS, files: [], id: 'three', run: 'exit 3', exit: 3 }] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 3);
  assert.match(result.out, /finding \S+: .*later.*before the change/);
  assert.match(result.out, /checkpoint three: keeps-working base 3 head 3 met/);
});

test('keepGreen runs at head: red is a finding, green is clean, and test off does not run it', async () => {
  const red = fixture({ lane: { keepGreen: 'exit 4' } });
  const redResult = await red.join(ON);
  assert.equal(redResult.code, 3);
  assert.match(redResult.out, /finding keepgreen/);
  const green = fixture({ lane: { keepGreen: 'true' } });
  assert.equal((await green.join(ON)).code, 0);
  assert.doesNotMatch((await red.join()).out, /keepgreen/);
});

test('F4: test on and no checkpoints prints "checkpoints: none" and is never waived', async () => {
  const f = fixture({ withTests: true });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 0, result.out);
  assert.ok(lines(result).includes('checkpoints: none'));
  assert.doesNotMatch(result.out, /waiver-at/);
});

test('waiver-at needs --tests, a red-first checkpoint, no finding and no --dispute', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [RED_FIRST] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  assert.match((await f.join([...ON, '--dispute'])).out, /^joined /m);
  assert.doesNotMatch((await f.join([...ON, '--dispute'])).out, /waiver-at/);
  assert.doesNotMatch((await f.join(ON, { noTests: true })).out, /waiver-at/);
  assert.match((await f.join(ON)).out, /waiver-at/);
  const keepsOnly = fixture({ withTests: true, lane: { checkpoints: [KEEPS] } });
  assert.doesNotMatch((await keepsOnly.join(ON)).out, /waiver-at/);
});

test('outOfScope: one finding per file outside the lane files, appendOnly and the test-writer files; names with spaces and shell characters stay whole', async () => {
  const hostile = 'other/a b;touch pwned.txt $(id).txt';
  const f = fixture({ withTests: true });
  commit(f.worktree, { 'src/my file.txt': 'in scope\n', 'docs/catalog.md': 'row\n', [hostile]: 'out\n', 'other/two.txt': 'out\n' });
  const result = await f.join();
  assert.equal(result.code, 3);
  const found = lines(result).filter((line) => line.startsWith('finding '));
  assert.equal(found.length, 2, result.out);
  assert.ok(found.some((line) => line.includes(hostile)));
  assert.ok(found.some((line) => line.includes('other/two.txt')));
  assert.ok(!existsSync(join(f.worktree, 'pwned.txt')) && !existsSync(join(f.root, 'pwned.txt')));
});

test('F3: a file name with a newline, or a checkpoint that prints "waiver-at", cannot forge a waiver-at line', async () => {
  const f = fixture({ lane: { checkpoints: [{ ...KEEPS, files: [], run: 'echo "waiver-at ' + 'f'.repeat(40) + '"; exit 5' }] } });
  commit(f.worktree, { [`other/x\nwaiver-at ${'e'.repeat(40)}`]: 'out\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 3);
  assert.ok(!lines(result).some((line) => line.startsWith('waiver-at')), result.out);
  assert.match(result.out, /other\/x\\nwaiver-at/);
});

test('F5: lane files and checkpoint files written with backslashes match the git paths', async () => {
  const f = fixture({ withTests: true, lane: { files: ['src\\sub\\'], checkpoints: [{ ...KEEPS, files: ['tests\\a.test.mjs'] }] } });
  commit(f.worktree, { 'src/sub/x.txt': 'x\n' });
  const result = await f.join(ON);
  assert.equal(result.code, 0, result.out);
  commit(f.worktree, { [TEST_FILE]: 'edited\n' });
  assert.match((await f.join(ON)).out, /contractTouched/);
});

test('ui-files counts the UI files of the range by the ui-proof definition', async () => {
  const f = fixture({ lane: { files: ['src/'] } });
  commit(f.worktree, { 'src/page.css': 'a { color: red }\n' });
  const result = await f.join();
  assert.ok(lines(result).includes('ui-files: 1'), result.out);
});

test('tests that do not apply (one test commit conflicts) exit 1 "tests do not apply" and leave no cherry-pick running', async () => {
  const f = fixture({ withTests: true });
  commit(f.testsTree, { 'shared.txt': 'one\nTWO from tests\nthree\n' }, 'tests touch a shared file');
  commit(f.worktree, { 'shared.txt': 'one\nTWO from lane\nthree\n' });
  const before = f.head();
  const result = await f.join(ON);
  assert.equal(result.code, 1);
  assert.match(result.out, /tests do not apply/);
  assert.equal(git(f.worktree, 'rev-list', '--count', `${before}..HEAD`), '1', 'only the test commit that applied cleanly stays; the conflicting one was aborted');
  assert.equal(git(f.worktree, 'status', '--porcelain'), '');
  assert.doesNotMatch(git(f.worktree, 'status'), /cherry-pick/);
});

test('inputs: a wrong road hash, an unknown lane, an unreadable or invalid road and a base that is not an ancestor all exit 1', async () => {
  const f = fixture();
  assert.equal((await f.join([], { sha256: 'a'.repeat(64) })).code, 1);
  assert.match((await f.join([], { sha256: 'a'.repeat(64) })).out, /sha256/);
  assert.equal((await f.join([], { lane: 'nope' })).code, 1);
  assert.match((await f.join([], { lane: 'nope' })).out, /nope/);
  const unrelated = commit(f.testsTree ?? f.repo, { 'z.txt': 'z\n' }, 'moves main'); // main moved past the lane: not an ancestor of the lane tip
  assert.equal((await f.join([], { base: unrelated })).code, 1);
  const missing = await runRoad(['join', join(f.root, 'absent.json'), '--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha]);
  assert.equal(missing.code, 1);
  writeFileSync(f.roadFile, '{ not json');
  assert.equal((await f.join()).code, 1);
});

test('usage: missing or malformed flags exit 2 and unknown flags are refused', async () => {
  const f = fixture();
  const run = (...rest) => runRoad(['join', f.roadFile, ...rest]);
  assert.equal((await run()).code, 2);
  assert.equal((await run('--road-sha256', 'zz', '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha)).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', 'relative/wt', '--base', f.baseSha)).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', 'main')).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha, '--bogus')).code, 2);
  assert.equal((await run('--road-sha256', f.sha256, '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha, '--checks', 'Test;rm')).code, 2);
});

test('--json prints one object with the joined sha, findings, ui files, checkpoints and the waiver', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [RED_FIRST] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const parsed = JSON.parse((await f.join([...ON, '--json'])).out);
  assert.equal(parsed.joined, f.head());
  assert.equal(parsed.waiverAt, f.head());
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.uiFiles, 0);
  assert.equal(parsed.checkpoints[0].id, 'feat');
});

test('F1: a join refuses a worktree with a cherry-pick running, uncommitted tracked changes, or a HEAD that moves during the join', async () => {
  const running = fixture({ withTests: true });
  commit(running.testsTree, { 'shared.txt': 'one\nTWO from tests\nthree\n' }, 'tests touch a shared file');
  commit(running.worktree, { 'shared.txt': 'one\nTWO from lane\nthree\n' });
  const tests = git(running.testsTree, 'rev-parse', 'HEAD');
  assert.throws(() => git(running.worktree, 'cherry-pick', tests), /conflict|could not apply/i);
  const stopped = await running.join(ON);
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /cherry-pick/);

  const dirty = fixture();
  writeFileSync(join(dirty.worktree, 'src/a.mjs'), 'edited, not committed\n');
  assert.equal((await dirty.join(ON)).code, 1);

  const moving = fixture({ lane: { checkpoints: [{ ...KEEPS, files: [], run: 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m second-join' }] } });
  const moved = await moving.join(ON);
  assert.equal(moved.code, 1);
  assert.match(moved.out, /moved/);
  assert.doesNotMatch(moved.out, /waiver-at/);
});

test('F1: one join at a time per worktree: a live holder refuses at once, a dead holder\'s lock is removed, and the lock is released after any outcome', async () => {
  const f = fixture({ lane: { checkpoints: [{ ...KEEPS, files: [], run: 'true' }] } });
  const lock = resolve(f.worktree, git(f.worktree, 'rev-parse', '--git-path', 'road-join.lock'));
  const held = (pid) => { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(pid)); };
  held(process.pid);
  const refused = await f.join(ON);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /another join runs/);
  assert.ok(existsSync(lock), 'a refused join leaves the holder\'s lock alone');
  rmSync(lock, { recursive: true });
  held(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim());
  assert.equal((await f.join(ON)).code, 0);
  assert.ok(!existsSync(lock), 'released after a clean join');
  commit(f.worktree, { 'elsewhere/x.txt': 'x\n' });
  assert.equal((await f.join(ON)).code, 3);
  assert.ok(!existsSync(lock), 'released after a join with findings');
  git(f.worktree, 'reset', '--hard', '-q', 'HEAD~1');
  writeFileSync(join(f.worktree, 'src/a.mjs'), 'dirty\n');
  assert.equal((await f.join(ON)).code, 1);
  assert.ok(!existsSync(lock), 'released after a refusal');
});

/** The pid of a process that has ended, so a leftover folder named with it is a crash's. */
const deadPid = () => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
const registered = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));

test('F2: base-side worktrees are always removed; a killed join\'s leftover (dead pid) is removed on the next run, a live one is not', async () => {
  const f = fixture({ withTests: true, lane: { checkpoints: [RED_FIRST, { ...KEEPS, id: 'boom', run: 'exit 9', exit: 9 }] } });
  commit(f.worktree, { 'src/feature.txt': 'x\n' });
  const stale = mkdtempSync(join(realpathSync(tmpdir()), `road-join-${deadPid()}-`));
  const live = mkdtempSync(join(realpathSync(tmpdir()), `road-join-${process.pid}-`));
  try {
    git(f.repo, 'worktree', 'add', '-q', '--detach', stale, f.baseSha);
    git(f.repo, 'worktree', 'add', '-q', '--detach', live, f.baseSha);
    const result = await f.join(ON);
    assert.equal(result.code, 0, result.out);
    const after = registered(f.repo);
    assert.ok(!after.includes(stale) && !existsSync(stale), 'the dead join\'s worktree is removed');
    assert.ok(after.includes(live), 'a worktree of a live process is left alone');
    assert.deepEqual(after.filter((path) => /road-join-\d+-/.test(path)), [live], 'this join left none behind');
  } finally {
    git(f.repo, 'worktree', 'remove', '--force', live);
    rmSync(stale, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

test('the CLI maps the exits: usage 2, hash mismatch 1, and a usage line on stderr', () => {
  const f = fixture();
  const cli = (...rest) => spawnSync(process.execPath, [ROAD_CLI, 'join', f.roadFile, ...rest], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(cli().status, 2);
  const mismatch = cli('--road-sha256', 'b'.repeat(64), '--lane', 'a', '--worktree', f.worktree, '--base', f.baseSha);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /sha256/);
});
