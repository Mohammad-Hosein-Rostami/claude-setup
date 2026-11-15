// Tests for the "not started yet" rule of `git-tidy prune`: a lane created from the base that has no commit of its own is
// not merged work, so --include-recent does not lift the 60-minute protection for it. Each test builds a repo in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, backdate, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const applyNow = (dir) => tidy(['prune', dir, '--apply', '--include-recent'], { cwd: dir });
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
const keptLine = (result, kind, subject) => lines(result).find((line) => line.startsWith(`kept ${kind} ${subject} `)) ?? '';
const NOT_STARTED = /not started yet \(no commit of its own\), used in the last 60 min/;

test('a fresh lane with no commit is kept with --include-recent, and the reason says why', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-new', 'new-lane');
  const result = applyNow(dir);
  assert.equal(result.status, 1);
  assert.match(keptLine(result, 'merged-worktree', wt), NOT_STARTED);
  assert.ok(existsSync(wt) && branches(dir).includes('new-lane'));
});

test('the same lane after one commit that is fast-forwarded into the base is removed with --include-recent', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-done', 'done-lane');
  commit(wt, 'work.txt');
  git(dir, 'merge', '-q', '--ff-only', 'done-lane');
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main']);
});

test('a lane with no commit that was last used more than 60 minutes ago is removed as before', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-abandoned', 'abandoned-lane');
  backdate(wt);
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main']);
});

test('a commit that was reset away is still held by the reflog rule, not by the new one', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-reset', 'reset-lane');
  commit(wt, 'dropped.txt');
  git(wt, 'reset', '-q', '--hard', 'main');
  backdate(wt);
  const result = applyNow(dir);
  assert.equal(result.status, 1);
  assert.match(keptLine(result, 'merged-worktree', wt), /reflog holds commits that are not on the base \(1\)/);
  assert.ok(existsSync(wt) && branches(dir).includes('reset-lane'));
});

test('a branch reflog that is missing counts as started: the lane is removed as it was before this rule', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-nolog', 'nolog-lane');
  rmSync(join(dir, '.git', 'logs', 'refs', 'heads', 'nolog-lane'));
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main']);
});

test('a fresh lane with no commit is kept in the plan too (worktree and branch)', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-plan', 'plan-lane');
  const plan = tidy(['prune', dir, '--include-recent'], { cwd: dir });
  assert.ok(lines(plan).some((line) => line.startsWith(`keep merged-worktree ${wt} `) && NOT_STARTED.test(line)), plan.stdout);
  assert.ok(lines(plan).some((line) => line.startsWith('keep merged-branch plan-lane ')), plan.stdout);
});
