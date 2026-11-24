// Tests for the sweep at the end of home/tools/land/land.mjs (sweep.mjs): after a landing, every branch folded into the landed
// lane (fixup and autosquash, fast-forward then rebase, cherry-pick, a lower stacked lane) is deleted with its clean worktree,
// each deletion is logged so it can be restored, and a lane reset after the fold keeps what it folded.
// Every test here is new behaviour (the land before the sweep deleted only the landed lane): each fails on the old sources.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addWorktree, backdate, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { addWorktreeAt, branchExists, land, laneFixedOnTestBranch, logRecords, outputLines, tipOf } from './land-sweep-helpers.mjs';

const LANE = 'lane/l';
const TEST = 'test/t';
// A test command both sh and cmd run as typed.
const PASS = 'exit 0';
const KEEP_TODO = 'sequence.editor=true';

/**
 * Plan case b: `TEST` (own worktree, one commit) fast-forwarded into `LANE`, then the base moves, `LANE` is rebased onto it and
 * its tip amended with an edit, so the test commit is in the lane's reflog only. The test worktree was last used two hours ago.
 * With `baseMovesAgain` the base gets one more commit, so landing has to rebase the lane again.
 */
function testFastForwardedThenRebased({ baseMovesAgain = false } = {}) {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  const testTree = addWorktreeAt(repo, 'test', TEST, `refs/heads/${LANE}`);
  const testTip = commit(testTree, 'lane.test.txt', 'first check\n');
  git(laneTree, 'merge', '--ff-only', '-q', TEST);
  commit(repo, 'other.txt');
  git(laneTree, 'rebase', '-q', 'main');
  writeFileSync(join(laneTree, 'lane.test.txt'), 'edited check\n');
  git(laneTree, 'commit', '-q', '-a', '--amend', '--no-edit');
  if (baseMovesAgain) commit(repo, 'other-again.txt');
  backdate(testTree);
  return { repo, laneTree, testTree, testTip };
}

test('a: landing the test branch that fixed a lane by fixup and autosquash deletes the lane and its clean worktree', () => {
  const { repo, laneTree, testTree, laneTip, testTip } = laneFixedOnTestBranch();
  const result = land(['test/x', '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout), [
    `landed test/x on main at ${testTip} (2 commit(s))`,
    `removed worktree ${testTree}`,
    'deleted branch test/x',
    `removed worktree ${laneTree}`,
    `deleted lane/x (was ${laneTip}, folded into test/x)`,
    'left: none',
  ]);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.equal(existsSync(laneTree), false, 'the folded lane worktree is gone');
  assert.equal(git(repo, 'rev-parse', 'main'), testTip);
});

test('q: the logged deletion names the sha that restores the deleted branch at the same tip', () => {
  const { repo, laneTip } = laneFixedOnTestBranch();
  assert.equal(land(['test/x', '--repo', repo], repo).status, 0);
  const deletions = logRecords(repo).filter((record) => record.deleted).map(({ deleted }) => ({ ...deleted, at: typeof deleted.at }));
  assert.deepEqual(deletions, [{ branch: 'lane/x', sha: laneTip, reason: 'folded into test/x', at: 'number' }]);
  git(repo, 'branch', 'lane/x', deletions[0].sha);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
});

test('b: a test branch fast-forwarded into the lane, then rewritten by a rebase with an edit, is deleted when the lane lands', () => {
  const { repo, testTree, testTip } = testFastForwardedThenRebased();
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), [
    `removed worktree ${testTree}`,
    `deleted ${TEST} (was ${testTip}, folded into ${LANE})`,
    'left: none',
  ]);
  assert.equal(branchExists(repo, TEST), false);
});

test('s: the lane history is read before the test gate moves the lane, so a land with --test still proves the fold', () => {
  // The base moved, so the gate rebases the lane and its `switch -C` logs `branch: Reset to HEAD`, which ends a history read
  // after it (git logs no entry when the branch stays where it was, so without the move this test could not fail).
  const { repo, laneTree, testTree, testTip } = testFastForwardedThenRebased({ baseMovesAgain: true });
  const result = land([LANE, '--repo', repo, '--test', PASS], repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout), [
    `testing ${tip} in ${laneTree}: ${PASS}`,
    `test passed on ${tip}`,
    `landed ${LANE} on main at ${tip} (2 commit(s))`,
    `removed worktree ${laneTree}`,
    `deleted branch ${LANE}`,
    `removed worktree ${testTree}`,
    `deleted ${TEST} (was ${testTip}, folded into ${LANE})`,
    'left: none',
  ]);
});

test('c: a cherry-picked fold that was amended after the pick is proven by its patch id and deleted', () => {
  const repo = makeRepo();
  const testTree = addWorktree(repo, 'test', TEST);
  const testTip = commit(testTree, 'shared.test.txt', 'first check\n');
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  git(laneTree, 'cherry-pick', testTip);
  writeFileSync(join(laneTree, 'shared.test.txt'), 'amended check\n');
  git(laneTree, 'commit', '-q', '-a', '--amend', '--no-edit');
  backdate(testTree);
  // The patch-id path, not ancestry: the test commit is not reachable from any position of the lane's history.
  const lanePositions = git(repo, 'reflog', 'show', '--format=%H', `refs/heads/${LANE}`).split('\n');
  assert.equal(git(repo, 'rev-list', ...lanePositions).split('\n').includes(testTip), false);
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), [
    `removed worktree ${testTree}`,
    `deleted ${TEST} (was ${testTip}, folded into ${LANE})`,
    'left: none',
  ]);
});

test('d: a lower stacked lane whose commit the top fixed by autosquash is deleted with its worktree when the top lands', () => {
  const repo = makeRepo();
  const lowerTree = addWorktree(repo, 'lower', 'lane/s');
  const lowerFirst = commit(lowerTree, 'lower.txt', 'lower v1\n');
  const lowerTip = commit(lowerTree, 'lower-more.txt');
  const topTree = addWorktreeAt(repo, 'top', 'lane/top', 'refs/heads/lane/s');
  commit(topTree, 'top.txt');
  writeFileSync(join(topTree, 'lower.txt'), 'lower v2\n');
  git(topTree, 'commit', '-q', '-a', `--fixup=${lowerFirst}`);
  git(topTree, '-c', KEEP_TODO, 'rebase', '-q', '-i', '--autosquash', 'main');
  backdate(lowerTree);
  const result = land(['lane/top', '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), [
    `removed worktree ${lowerTree}`,
    `deleted lane/s (was ${lowerTip}, folded into lane/top)`,
    'left: none',
  ]);
  assert.equal(existsSync(lowerTree), false);
});

test('f: a lane reset with --soft and recommitted after folding a test branch keeps that branch and names it in left:', () => {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  const testTree = addWorktreeAt(repo, 'test', TEST, `refs/heads/${LANE}`);
  const testTip = commit(testTree, 'lane.test.txt');
  git(repo, 'worktree', 'remove', testTree);
  git(laneTree, 'merge', '--ff-only', '-q', TEST);
  git(laneTree, 'reset', '-q', '--soft', 'main');
  git(laneTree, 'commit', '-q', '-m', 'lane and its test in one commit');
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout), [
    `landed ${LANE} on main at ${tip} (1 commit(s))`,
    `removed worktree ${laneTree}`,
    `deleted branch ${LANE}`,
    'left:',
    `  ${TEST}: active, ahead 2`, // the lane commit and the test commit: neither patch is the squashed one on main
  ]);
  assert.equal(tipOf(repo, TEST), testTip, 'the reset ends the proof, so the folded branch stays');
});
