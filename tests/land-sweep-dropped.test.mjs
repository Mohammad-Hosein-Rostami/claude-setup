// Repro tests for land's sweep (home/tools/land/sweep.mjs, git-tidy lib/branches.mjs content proof): a commit that the landed
// lane once held but dropped with `git rebase --onto` (which writes no reset entry to its reflog) is not on the base, so the
// branch that holds it must stay. Both failed on the old history proof: the branch was deleted as "folded" while its commit
// was on no branch.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { addWorktree, backdate, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { addWorktreeAt, land, outputLines, tipOf } from './land-sweep-helpers.mjs';

const LANE = 'lane/L';
const TEST = 'test/T';

/** Lands `branch` from `repo` and returns its output lines after the three of the landing itself (landed, worktree, branch). */
function sweepLines(repo, branch) {
  const result = land([branch, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  return outputLines(result.stdout).slice(3);
}

test('R1: a test branch fast-forwarded into the lane, then dropped from it by rebase --onto, is kept when the lane lands', () => {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', LANE);
  const laneFirst = commit(laneTree, 'lane.txt');
  const testTree = addWorktreeAt(repo, 'test', TEST, `refs/heads/${LANE}`);
  const testTip = commit(testTree, 'lane.test.txt');
  git(laneTree, 'merge', '--ff-only', '-q', TEST);
  commit(laneTree, 'lane-more.txt');
  git(laneTree, 'rebase', '-q', '--onto', laneFirst, testTip); // drops the test commit, keeps the one after it
  backdate(testTree);
  assert.equal(git(repo, 'ls-tree', '--name-only', LANE, 'lane.test.txt'), '', 'precondition: the lane no longer holds the test commit');
  assert.deepEqual(sweepLines(repo, LANE), ['left:', `  ${TEST}: active, ahead 1`]);
  assert.equal(tipOf(repo, TEST), testTip);
  assert.ok(existsSync(testTree), 'its worktree stays');
});

test('R1: a lower lane the top was stacked on, then unstacked from by rebase --onto main, is kept when the top lands', () => {
  const repo = makeRepo();
  const lowerTree = addWorktree(repo, 'lower', 'lane/S');
  const lowerTip = commit(lowerTree, 'lower.txt');
  const topTree = addWorktreeAt(repo, 'top', LANE, 'refs/heads/lane/S');
  commit(topTree, 'top.txt');
  git(topTree, 'rebase', '-q', '--onto', 'main', 'lane/S');
  backdate(lowerTree);
  assert.deepEqual(sweepLines(repo, LANE), ['left:', '  lane/S: active, ahead 1']);
  assert.equal(tipOf(repo, 'lane/S'), lowerTip);
  assert.ok(existsSync(lowerTree), 'its worktree stays');
});
