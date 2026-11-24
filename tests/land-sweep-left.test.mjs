// Tests for what the sweep at the end of home/tools/land/land.mjs keeps and how it says so: the `left:` block (in a live lane,
// active, idle, `+N more`), the branches that are never deleted, a sweep skipped for a rebase in another worktree, and a
// landing log that cannot be written or holds lines that do not parse.
// New behaviour unless a test says it is a guard: the land before the sweep printed no `left:` block, so each fails on the old
// sources. Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import {
  addWorktreeAt, branchExists, commitAt, land, laneFixedOnTestBranch, logPath, logRecords, outputLines, tipOf,
} from './land-sweep-helpers.mjs';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
// Past check.mjs UNLANDED_AFTER_HOURS (2), with ten minutes to spare so the whole hours read 3.
const IDLE_MS = 3 * MS_PER_HOUR + 10 * MS_PER_MINUTE;
const MAX_LEFT_SHOWN = 20; // sweep.mjs shows this many `left:` lines, then `+N more`
const EXTRA_BRANCHES = 3;
const READ_ONLY = 0o444;

/** Lands `branch` from `repo` and returns its output lines after the three of the landing itself (landed, worktree, branch). */
function sweepLines(repo, branch) {
  const result = land([branch, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  return outputLines(result.stdout).slice(3);
}

test('e: a lane stacked under a live top that has not landed stays, left: says it lands with the top, check says in-lane?', () => {
  const repo = makeRepo();
  const lowerTree = addWorktree(repo, 'lower', 'lane/s');
  const lowerTip = commit(lowerTree, 'lower.txt');
  const topTree = addWorktreeAt(repo, 'top', 'lane/top', 'refs/heads/lane/s');
  commit(topTree, 'top.txt');
  commit(addWorktree(repo, 'other', 'lane/other'), 'other.txt');
  assert.deepEqual(sweepLines(repo, 'lane/other'), ['left:', '  lane/s: in lane/top (lands with it)', '  lane/top: active, ahead 2']);
  assert.equal(tipOf(repo, 'lane/s'), lowerTip);
  const check = tidy(['check', repo], { cwd: repo });
  assert.ok(outputLines(check.stdout).includes('in-lane? lane/s all its commits are in lane/top; it goes when lane/top lands'), check.stdout);
  assert.equal(outputLines(check.stdout).some((line) => line.startsWith('unmerged-branch? lane/s ')), false, 'the hint replaces unmerged-branch?');
});

test('p: past 20 branches left: shows the first 20 and then +N more', () => {
  const repo = makeRepo();
  const tree = git(repo, 'rev-parse', `${commit(repo, 'open.txt')}^{tree}`);
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  const names = Array.from({ length: MAX_LEFT_SHOWN + EXTRA_BRANCHES }, (_, i) => `open/${String(i).padStart(2, '0')}`);
  // Each branch gets its own tip (branches at one tip are copies, and prune keeps only one of them).
  for (const name of names) git(repo, 'update-ref', `refs/heads/${name}`, git(repo, 'commit-tree', tree, '-p', 'main', '-m', name));
  commit(addWorktree(repo, 'lane', 'lane/l'), 'lane.txt');
  assert.deepEqual(sweepLines(repo, 'lane/l'), [
    'left:',
    ...names.slice(0, MAX_LEFT_SHOWN).map((name) => `  ${name}: active, ahead 1`),
    `  +${EXTRA_BRANCHES} more`,
  ]);
});

test('u: the base, live and idle lanes and a lane with its own commit on top of a folded one are never deleted', () => {
  const { repo, laneTree, laneTip, testTip } = laneFixedOnTestBranch();
  commit(addWorktree(repo, 'live', 'lane/live'), 'live.txt');
  const oldTree = addWorktree(repo, 'old', 'lane/old');
  const oldTip = commitAt(oldTree, 'old.txt', 'old\n', IDLE_MS);
  git(repo, 'worktree', 'remove', oldTree);
  // lane/partial holds the folded commit and one of its own, so not all of its commits are in what landed.
  const partialTree = addWorktreeAt(repo, 'partial', 'lane/partial', 'refs/heads/lane/x');
  const partialTip = commit(partialTree, 'partial.txt');
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `removed worktree ${laneTree}`,
    `deleted lane/x (was ${laneTip}, folded into test/x)`,
    'left:',
    '  lane/live: active, ahead 1',
    '  lane/old: idle 3 h, ahead 1',
    '  lane/partial: active, ahead 2',
  ]);
  assert.deepEqual([tipOf(repo, 'main'), tipOf(repo, 'lane/old'), tipOf(repo, 'lane/partial')], [testTip, oldTip, partialTip]);
  assert.ok(branchExists(repo, 'lane/live'));
});

test('r: a landing log that cannot be written is said on stderr, the lane still lands with exit 0 and its folds stay', () => {
  const { repo, testTree, testTip } = laneFixedOnTestBranch();
  writeFileSync(logPath(repo), '');
  chmodSync(logPath(repo), READ_ONLY);
  assert.throws(() => appendFileSync(logPath(repo), 'x'), 'precondition: this process cannot write the log either');
  const result = land(['test/x', '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^land: the landing record could not be written \(.+\); branches folded into test\/x stay\n$/);
  assert.deepEqual(outputLines(result.stdout), [
    `landed test/x on main at ${testTip} (2 commit(s))`,
    `removed worktree ${testTree}`,
    'deleted branch test/x',
    'left:',
    '  lane/x: active, ahead 1',
  ]);
  assert.equal(tipOf(repo, 'main'), testTip);
  assert.equal(branchExists(repo, 'test/x'), false);
});

test('j: a rebase stopped in another worktree skips the sweep with exit 0, and a later prune deletes the folded branch', () => {
  const { repo, laneTip } = laneFixedOnTestBranch();
  const otherTree = addWorktree(repo, 'other', 'lane/other');
  commit(otherTree, 'other.txt');
  const stopped = spawnSync('git', ['rebase', '-q', '--exec', 'exit 1', 'main'], { cwd: otherTree, encoding: 'utf8', env: CLEAN_ENV });
  assert.notEqual(stopped.status, 0, 'precondition: the rebase stopped');
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `cleanup skipped: a rebase is not finished in ${otherTree}; finish or abort it before --apply`,
    'left:',
    '  lane/other: active, ahead 1',
    '  lane/x: active, ahead 1',
  ]);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  git(otherTree, 'rebase', '--abort');
  const pruned = tidy(['prune', repo, '--apply'], { cwd: repo });
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.deepEqual(logRecords(repo).filter((record) => record.deleted).map(({ deleted }) => [deleted.branch, deleted.sha]), [['lane/x', laneTip]]);
});

test('k: lines that do not parse or do not match a record are skipped: land neither crashes nor loses the new landing', () => {
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch();
  writeFileSync(logPath(repo), 'not json\n{"landed": {"branch": "test/x"}}\n[]\n');
  assert.deepEqual(sweepLines(repo, 'test/x'), [`removed worktree ${laneTree}`, `deleted lane/x (was ${laneTip}, folded into test/x)`, 'left: none']);
});

// Repro (found by this test): a torn write leaves a last line with no newline; the next record is appended to that same line,
// so it does not parse either, and the landing it records proves nothing. Fails on the tip: lane/x is listed as
// `lane/x: active, ahead 1` instead of being deleted.
test('k: a torn last line (no newline) in the log does not swallow the record of the next landing', () => {
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch();
  writeFileSync(logPath(repo), '{"landed": {"branch": "test/x", "tip": "ab');
  assert.deepEqual(sweepLines(repo, 'test/x'), [`removed worktree ${laneTree}`, `deleted lane/x (was ${laneTip}, folded into test/x)`, 'left: none']);
});
