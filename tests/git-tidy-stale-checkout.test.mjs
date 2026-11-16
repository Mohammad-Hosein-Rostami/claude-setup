// Tests for the `stale-checkout` finding of `git-tidy check`: a folder whose checked-out branch was moved forward under it by plumbing
// (`git update-ref` from another worktree), so its index still holds an earlier position of the branch and every file shows as a
// staged change. Each test builds its own repo in a temp folder (git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const check = (dir) => tidy(['check', dir], { cwd: dir });
const staleLines = (result) => lines(result).filter((line) => line.startsWith('stale-checkout '));

/** A lane worktree with two commits ahead of main; returns [lane folder, lane tip]. */
function laneAhead(dir) {
  const lane = addWorktree(dir, 'wt-lane', 'lane');
  commit(lane, 'one.txt');
  return [lane, commit(lane, 'two.txt')];
}

const advice = (dir) => `git -C ${dir} status, then reset only after backing up real edits`;

test('main moved by update-ref from a lane worktree: the main folder is stale-checkout with the old and new tips', () => {
  const dir = makeRepo();
  const old = git(dir, 'rev-parse', '--short', 'HEAD');
  const [lane, tip] = laneAhead(dir);
  git(lane, 'update-ref', 'refs/heads/main', tip);
  const result = check(dir);
  assert.equal(result.status, 1);
  const short = git(dir, 'rev-parse', '--short', tip);
  assert.deepEqual(staleLines(result), [`stale-checkout ${dir} index is at ${old}, branch main moved to ${short} under it (2 commits): ${advice(dir)}`]);
});

test('main moved by git -C <main folder> update-ref (its own HEAD reflog follows): still stale-checkout', () => {
  const dir = makeRepo();
  const [, tip] = laneAhead(dir);
  git(dir, 'update-ref', 'refs/heads/main', tip);
  assert.equal(staleLines(check(dir)).length, 1);
});

test('a lane landed with merge --ff-only in the main folder is not stale-checkout', () => {
  const dir = makeRepo();
  laneAhead(dir);
  git(dir, 'merge', '-q', '--ff-only', 'lane');
  assert.deepEqual(staleLines(check(dir)), []);
});

test('real staged edits, a soft reset and a branch moved while no folder has it checked out are not stale-checkout', () => {
  const staged = makeRepo();
  writeFileSync(join(staged, 'staged.txt'), 'new');
  git(staged, 'add', 'staged.txt');
  const softReset = makeRepo();
  commit(softReset, 'second.txt');
  git(softReset, 'reset', '-q', '--soft', 'HEAD~1'); // the index now equals the earlier tip, which is ahead of the branch, not behind it
  const spare = makeRepo();
  const [lane, tip] = laneAhead(spare);
  git(lane, 'branch', 'spare', 'main');
  git(lane, 'update-ref', 'refs/heads/spare', tip);
  for (const dir of [staged, softReset, spare]) assert.deepEqual(staleLines(check(dir)), [], dir);
});

test('a repository whose reflog is off is checked without an error and without stale-checkout', () => {
  const noReflog = makeRepo();
  git(noReflog, 'config', 'core.logAllRefUpdates', 'false');
  git(noReflog, 'reflog', 'expire', '--expire=all', '--all');
  writeFileSync(join(noReflog, 'b.txt'), 'b');
  git(noReflog, 'add', 'b.txt');
  const result = check(noReflog);
  assert.notEqual(result.status, 2, result.stderr);
  assert.deepEqual(staleLines(result), []);
});
