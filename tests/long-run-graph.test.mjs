// Tests of the run graph (spec 7.1, 7.7, M8, M9, M10; acceptance 6, 7, 8): branching with its visit guard, re-runs from an earlier
// step, and parallel groups (at most maxParallel bosses alive, join holds, one item answered, lane worktrees). The driver runs in
// this process on a fake clock with the fake claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, driveRun, journalOf, makeSandbox, readCalls } from './long-run-helpers.mjs';

const git = (cwd, ...args) => {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

function gitRepo(box) {
  const repo = box.work('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

test('branching: build fails -> fix -> build; a build that always fails holds on maxVisits 3 and never loops on', async () => {
  const box = makeSandbox();
  box.script({ build: ['crash'], fix: ['done'] });
  const paths = createRun(box, {
    name: 'loop', cwd: box.work('repo'), loopGuards: { maxAttempts: 1 },
    steps: [{ id: 'build', prompt: 'Build.', next: { failed: 'fix' } }, { id: 'fix', prompt: 'Fix.', next: { done: 'build' } }],
  });
  assert.equal(await driveRun(box, paths), 'held');
  assert.deepEqual(readCalls(box).map((call) => call.step), ['build', 'fix', 'build', 'fix', 'build', 'fix']);
  const { hold } = readJson(paths.driver);
  assert.deepEqual([hold.stepId, hold.status, hold.reason], ['build', 'guard', 'loop guard: visited 3 times']);
});

test('rerun --from 2 after a done 3-step run: journals 2-3 set aside, 2-3 run again in new sessions, step 1 never, HEAD advice printed', async () => {
  const box = makeSandbox();
  const repo = gitRepo(box);
  const paths = createRun(box, { name: 'again', cwd: repo, steps: [{ id: 'one', prompt: 'One.' }, { id: 'two', prompt: 'Two.' }, { id: 'three', prompt: 'Three.' }] });
  assert.equal(await driveRun(box, paths), 'done');
  const before = Object.fromEntries(['two', 'three'].map((id) => [id, journalOf(paths, id).sessionId]));
  const head = journalOf(paths, 'two').headBefore;
  const result = cli(box, ['rerun', paths.runId, '--from', 'two', '--foreground']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(paths.steps, '.rerun-1', 'two.json')) && existsSync(join(paths.steps, '.rerun-1', 'three.json')));
  assert.ok(!existsSync(join(paths.steps, '.rerun-1', 'one.json')));
  assert.match(result.stdout, new RegExp(`git switch -c rerun-two ${head}`));
  assert.deepEqual(readCalls(box).map((call) => call.step), ['one', 'two', 'three', 'two', 'three']);
  for (const id of ['two', 'three']) assert.notEqual(journalOf(paths, id).sessionId, before[id]);
  assert.equal(readJson(paths.driver).status, 'done');
});

const group = (box, overrides = {}) => ({
  name: 'fan', cwd: box.work('repo'), maxParallel: 3,
  steps: [{ id: 'pages', parallel: ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, prompt: `Page ${id}.`, cwd: box.work(id) })), ...overrides }],
});

function maxAlive(calls) {
  const edges = calls.flatMap((call) => [[call.start, 1], [call.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let alive = 0;
  let most = 0;
  for (const [, delta] of edges) {
    alive += delta;
    most = Math.max(most, alive);
  }
  return most;
}

test('a group of 5 with maxParallel 3: never more than 3 bosses alive; one needs-owner -> the other 4 finish, join holds listing it; --item answer re-runs only it', async () => {
  const box = makeSandbox();
  box.script({ p1: ['sleep:400'], p2: ['sleep:400'], p3: ['needs-owner', 'echo'], p4: ['sleep:400'], p5: ['sleep:400'] });
  const paths = createRun(box, group(box));
  assert.equal(await driveRun(box, paths), 'held');
  const first = readCalls(box);
  assert.equal(first.length, 5);
  assert.ok(maxAlive(first) <= 3, `at most 3 alive, saw ${maxAlive(first)}`);
  assert.ok(maxAlive(first) >= 2, 'items ran side by side');
  const { hold } = readJson(paths.driver);
  assert.equal(hold.status, 'needs-owner');
  assert.deepEqual(hold.items.map((item) => [item.id, item.question]), [['p3', 'Which colour should the button be?']]);
  assert.equal(await driveRun(box, paths, { reply: { action: 'answer', text: 'blue', item: 'p3' } }), 'done');
  const again = readCalls(box).slice(5);
  assert.deepEqual(again.map((call) => call.step), ['p3']);
  assert.equal(again[0].stdin, 'The owner answered: blue');
});

test('worktree: true claims a lane per item on branch long-run/<run>/<item> from the HEAD of the group start', async () => {
  const box = makeSandbox();
  const repo = gitRepo(box);
  const paths = createRun(box, { name: 'lanes', cwd: repo, steps: [{ id: 'pages', worktree: true, parallel: [{ id: 'w1', prompt: 'One.' }, { id: 'w2', prompt: 'Two.' }] }] });
  assert.equal(await driveRun(box, paths), 'done');
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const id of ['w1', 'w2']) {
    const journal = journalOf(paths, id);
    assert.equal(journal.branch, `long-run/${paths.runId}/${id}`);
    assert.match(journal.worktree, /\.claude\/worktrees\/lane-\d+$/);
    assert.equal(git(journal.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(journal.worktree, 'branch', '--show-current'), journal.branch);
  }
  for (const call of readCalls(box)) assert.equal(call.cwd, realpathSync.native(journalOf(paths, call.step).worktree));
});

test('worktree: false with two items in one folder is refused by check (exit 1, the fix named)', () => {
  const box = makeSandbox();
  const folder = box.work('same');
  const job = box.writeJob({ name: 'same', cwd: folder, steps: [{ id: 'g', parallel: [{ id: 'x', prompt: 'X.' }, { id: 'y', prompt: 'Y.', cwd: folder }] }] });
  const result = cli(box, ['check', job]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without worktree: true every item needs its own cwd/);
});
