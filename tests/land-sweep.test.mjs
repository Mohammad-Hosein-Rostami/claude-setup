// Tests for the sweep at the end of home/tools/land/land.mjs (sweep.mjs): after a landing, a branch folded into the landed lane
// is deleted with its clean worktree only when its content is all on the base (unchanged, or squashed as it is); a fold that
// the lane changed (fixup and autosquash, an amend after a fast-forward or a cherry-pick, a lower stacked lane fixed up) stays
// and is named under `left:`. Each deletion is logged first, so it can be restored.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, backdate, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import {
  addWorktreeAt, branchExists, land, laneFixedOnTestBranch, laneSquashedOnTestBranch, logRecords, outputLines, tipOf,
} from './land-sweep-helpers.mjs';

const LANE = 'lane/l';
const TEST = 'test/t';
// A test command both sh and cmd run as typed.
const PASS = 'exit 0';
const KEEP_TODO = 'sequence.editor=true';

/**
 * Plan case b: `TEST` (own worktree, one commit) fast-forwarded into `LANE`, then the base moves and `LANE` is rebased onto it;
 * with `edit` its tip is amended with an edit of the test file, so the test commit's content is not what lands. The test
 * worktree was last used two hours ago. With `baseMovesAgain` the base gets one more commit, so landing rebases the lane again.
 */
function testFastForwardedThenRebased({ baseMovesAgain = false, edit = true } = {}) {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  const testTree = addWorktreeAt(repo, 'test', TEST, `refs/heads/${LANE}`);
  const testTip = commit(testTree, 'lane.test.txt', 'first check\n');
  git(laneTree, 'merge', '--ff-only', '-q', TEST);
  commit(repo, 'other.txt');
  git(laneTree, 'rebase', '-q', 'main');
  if (edit) {
    writeFileSync(join(laneTree, 'lane.test.txt'), 'edited check\n');
    git(laneTree, 'commit', '-q', '-a', '--amend', '--no-edit');
  }
  if (baseMovesAgain) commit(repo, 'other-again.txt');
  backdate(testTree);
  return { repo, laneTree, testTree, testTip };
}

test('a: a lane continued on a test branch and squashed with it is deleted with its clean worktree when the test branch lands', () => {
  const { repo, laneTree, testTree, laneTip, testTip } = laneSquashedOnTestBranch();
  const result = land(['test/x', '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout), [
    `landed test/x on main at ${testTip} (1 commit(s))`,
    `removed worktree ${testTree}`,
    'deleted branch test/x',
    `removed worktree ${laneTree}`,
    `deleted lane/x (was ${laneTip})`,
    'left: none',
  ]);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.equal(existsSync(laneTree), false, 'the folded lane worktree is gone');
  assert.equal(git(repo, 'rev-parse', 'main'), testTip);
});

// Safety (tess D-R2/D-R3 class): the lane's commit was fixed up, so its content (feature v1) is on no branch once test/x lands.
test('a: a lane whose commit the landed test branch fixed up by autosquash stays with its worktree, named under left:', () => {
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch();
  const result = land(['test/x', '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), ['left:', '  lane/x: active, ahead 1']);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  assert.ok(existsSync(laneTree), 'its worktree stays');
});

test('q: the logged deletion names the sha that restores the deleted branch at the same tip', () => {
  const { repo, laneTip } = laneSquashedOnTestBranch();
  assert.equal(land(['test/x', '--repo', repo], repo).status, 0);
  const deletions = logRecords(repo).map(({ deleted }) => ({ ...deleted, at: typeof deleted.at }));
  assert.deepEqual(deletions, [{ branch: 'lane/x', sha: laneTip, reason: 'content-equal', at: 'number' }]);
  git(repo, 'branch', 'lane/x', deletions[0].sha);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
});

test('b: a test branch fast-forwarded into the lane, then rewritten by a rebase with an edit, stays when the lane lands', () => {
  const { repo, testTree, testTip } = testFastForwardedThenRebased();
  const result = land([LANE, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), ['left:', `  ${TEST}: active, ahead 1`]);
  assert.equal(tipOf(repo, TEST), testTip);
  assert.ok(existsSync(testTree), 'its worktree stays');
});

test('s: with --test, a test branch the lane carried unchanged through two rebases is deleted after the landing', () => {
  // The base moved, so the gate rebases the lane again; the test commit's patch is on the base unchanged.
  const { repo, laneTree, testTree, testTip } = testFastForwardedThenRebased({ baseMovesAgain: true, edit: false });
  const result = land([LANE, '--repo', repo, '--test', PASS, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout), [
    `testing ${tip} in ${laneTree}: ${PASS}`,
    `test passed on ${tip}`,
    `landed ${LANE} on main at ${tip} (2 commit(s))`,
    `removed worktree ${laneTree}`,
    `deleted branch ${LANE}`,
    `removed worktree ${testTree}`,
    `deleted ${TEST} (was ${testTip})`,
    'left: none',
  ]);
});

test('c: a cherry-picked fold that was amended after the pick stays: its content is not on the base', () => {
  const repo = makeRepo();
  const testTree = addWorktree(repo, 'test', TEST);
  const testTip = commit(testTree, 'shared.test.txt', 'first check\n');
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  git(laneTree, 'cherry-pick', testTip);
  writeFileSync(join(laneTree, 'shared.test.txt'), 'amended check\n');
  git(laneTree, 'commit', '-q', '-a', '--amend', '--no-edit');
  backdate(testTree);
  const result = land([LANE, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), ['left:', `  ${TEST}: active, ahead 1`]);
  assert.equal(tipOf(repo, TEST), testTip);
});

test('c: a plain cherry-pick of a test branch is deleted with its worktree when the lane lands', () => {
  const repo = makeRepo();
  const testTree = addWorktree(repo, 'test', TEST);
  const testTip = commit(testTree, 'shared.test.txt', 'first check\n');
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  git(laneTree, 'cherry-pick', testTip);
  backdate(testTree);
  const result = land([LANE, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), [`removed worktree ${testTree}`, `deleted ${TEST} (was ${testTip})`, 'left: none']);
});

test('d: a lower stacked lane whose commit the top fixed by autosquash stays with its worktree when the top lands', () => {
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
  const result = land(['lane/top', '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), ['left:', '  lane/s: active, ahead 1']);
  assert.equal(tipOf(repo, 'lane/s'), lowerTip);
  assert.ok(existsSync(lowerTree), 'its worktree stays');
});

test('f: a lane reset with --soft and recommitted after folding a test branch deletes that branch: its content landed as it is', () => {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'lane.txt');
  const testTree = addWorktreeAt(repo, 'test', TEST, `refs/heads/${LANE}`);
  const testTip = commit(testTree, 'lane.test.txt');
  git(repo, 'worktree', 'remove', testTree);
  git(laneTree, 'merge', '--ff-only', '-q', TEST);
  git(laneTree, 'reset', '-q', '--soft', 'main');
  git(laneTree, 'commit', '-q', '-m', 'lane and its test in one commit');
  const result = land([LANE, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout), [
    `landed ${LANE} on main at ${tip} (1 commit(s))`,
    `removed worktree ${laneTree}`,
    `deleted branch ${LANE}`,
    `deleted ${TEST} (was ${testTip})`,
    'left: none',
  ]);
});

/** The verbatim patch id of commit `sha`, as git computes it from `git show`. */
function patchIdOf(repo, sha) {
  const shown = git(repo, 'show', '--format=', sha);
  const result = spawnSync('git', ['patch-id', '--verbatim'], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV, input: `${shown}\n` });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(' ')[0];
}

// Repro (tess-review R2): patch ids leave out line numbers, so the same line added at two places with the same three lines of
// context has one patch id. Fails on the tip: test/t is deleted as folded though its change is not on main.
test('R2: a test branch whose patch id equals a lane commit that changed another place in the file is kept', () => {
  const repo = makeRepo();
  const twice = `${['a', 'b', 'c', 'd', 'e', 'f'].join('\n')}\n`; // the same lines twice, so both places have one context
  commit(repo, 'shared.txt', `${twice}g\nh\n${twice}`);
  const testTree = addWorktree(repo, 'test', TEST);
  const testTip = commit(testTree, 'shared.txt', `a\nb\nc\nNEW\nd\ne\nf\ng\nh\n${twice}`);
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'shared.txt', `${twice}g\nh\na\nb\nc\nNEW\nd\ne\nf\n`);
  backdate(testTree);
  const laneTip = tipOf(repo, LANE);
  assert.equal(patchIdOf(repo, testTip), patchIdOf(repo, laneTip), 'precondition: the two commits have one patch id');
  const result = land([LANE, '--repo', repo, '--no-tick'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(3), ['left:', `  ${TEST}: active, ahead 1`]);
  assert.equal(tipOf(repo, TEST), testTip);
});
