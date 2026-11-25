// Tests for git-tidy's one content proof (home/tools/git-tidy/lib/branches.mjs `content-equal`) as `land`, `check` and
// `prune --apply` use it: a branch whose content is all on the base (merging it changes nothing) is deleted, with prune's
// safety checks: a worktree that holds work or is in use is kept with the reason and removed by a later prune once it is
// free; a branch that moves on is no longer merged; the deletion log is never read as proof; two branches at one tip are not
// inside each other (the in-lane? hint); branch names git allows pass through as they are.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findLeftovers } from '../home/tools/git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../home/tools/git-tidy/lib/prune.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { addWorktree, backdate, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import {
  branchExists, land, laneFixedOnTestBranch, laneSquashedOnTestBranch, logPath, logRecords, outputLines, tipOf, usedAgo,
} from './land-sweep-helpers.mjs';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const IN_USE = 'used 5 min ago (add --include-recent if you landed this lane yourself)';
const BUSY = '1 uncommitted or untracked files';
const LOCKED = 'locked; unlock it with `git worktree unlock` first';

const sweepLines = (repo, branch) => {
  const result = land([branch, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  return outputLines(result.stdout).slice(3);
};
const applyPrune = (repo) => {
  const result = tidy(['prune', repo, '--apply'], { cwd: repo });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
};

/** Case g: the content-equal lane/x's worktree is spoiled before the land, kept with `reason`, cleaned, then pruned. */
function keptUntilClean(spoil, clean, reason) {
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch();
  spoil(laneTree);
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `kept ${laneTree}: ${reason}`,
    `kept lane/x: checked out in ${laneTree}`,
    'left:',
    `  lane/x: kept: ${reason}`,
  ]);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  clean(laneTree);
  backdate(laneTree); // cleaning touched its files; the worktree was last used before the landing
  applyPrune(repo);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.equal(existsSync(laneTree), false);
}

test('g: a content-equal branch whose worktree has an uncommitted edit is kept, then deleted by prune --apply once it is clean', () => {
  keptUntilClean((tree) => writeFileSync(join(tree, 'feature.txt'), 'unsaved edit\n'), (tree) => git(tree, 'checkout', '--', 'feature.txt'), BUSY);
});

test('g: a content-equal branch whose worktree has an untracked file is kept, then deleted by prune --apply once it is gone', () => {
  keptUntilClean((tree) => writeFileSync(join(tree, 'notes.txt'), 'draft\n'), (tree) => rmSync(join(tree, 'notes.txt')), BUSY);
});

test('g: a content-equal branch whose worktree is locked is kept, then deleted by prune --apply once it is unlocked', () => {
  keptUntilClean((tree) => git(tree, 'worktree', 'lock', tree), (tree) => git(tree, 'worktree', 'unlock', tree), LOCKED);
});

test('h: a content-equal branch that got a new commit after the landing is no longer merged and stays', () => {
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch();
  writeFileSync(join(laneTree, 'feature.txt'), 'more work\n');
  sweepLines(repo, 'test/x');
  const before = outputLines(tidy(['check', repo], { cwd: repo }).stdout);
  assert.ok(before.includes(`merged-branch lane/x ${laneTip.slice(0, 7)} content-equal`), before.join('\n'));
  git(laneTree, 'commit', '-q', '-a', '-m', 'more work after the landing');
  const newTip = tipOf(repo, 'lane/x');
  backdate(laneTree);
  const after = outputLines(tidy(['check', repo], { cwd: repo }).stdout);
  assert.equal(after.some((line) => line.startsWith('merged-branch lane/x ')), false, after.join('\n'));
  applyPrune(repo);
  assert.equal(tipOf(repo, 'lane/x'), newTip);
});

test('i: a content-equal worktree used in the last 60 minutes is kept; once it is older it is removed', () => {
  const { repo, laneTree } = laneSquashedOnTestBranch();
  usedAgo(laneTree, 5 * MS_PER_MINUTE);
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `kept ${laneTree}: ${IN_USE}`,
    `kept lane/x: checked out in ${laneTree}`,
    'left:',
    `  lane/x: kept: ${IN_USE}`,
  ]);
  usedAgo(laneTree, 2 * MS_PER_HOUR);
  const pruned = outputLines(applyPrune(repo).stdout);
  assert.ok(pruned.some((line) => line.includes(laneTree)), pruned.join('\n'));
  assert.equal(existsSync(laneTree), false);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.deepEqual(logRecords(repo).map(({ deleted }) => deleted.branch), ['lane/x']);
});

/** A repo with an unmerged branch lane/x (one commit, no worktree) whose content is not on main. */
function unmergedLane() {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'lane/x');
  const laneTip = commit(repo, 'feature.txt');
  git(repo, 'switch', '-q', 'main');
  return { repo, laneTip };
}

// Guard: the log is a restore record only. The old sources took a `landed` record as proof of a fold; none of these deletes.
test('k: no line of the deletion log, a well-formed landing or deletion record included, ever deletes a branch', () => {
  const { repo, laneTip } = unmergedLane();
  const main = tipOf(repo, 'main');
  const landed = { branch: 'test/x', tip: laneTip, shas: [laneTip], patchIds: null, lastCommitMs: Date.now(), base: 'main', landedTip: main, landedAt: Date.now() };
  const lines = ['', 'not json', JSON.stringify({ landed }), JSON.stringify({ deleted: { branch: 'lane/x', sha: laneTip, reason: 'x', at: Date.now() } })];
  for (const text of lines) {
    writeFileSync(logPath(repo), text === '' ? '' : `${text}\n`);
    const result = applyPrune(repo);
    assert.equal(result.stderr, '', text);
    assert.equal(tipOf(repo, 'lane/x'), laneTip, text);
  }
});

test('l: branch names git allows (a/b.c, unicode) are proven, deleted and printed as they are', () => {
  const [lane, landed] = ['a/b.c', 'test/ünï-çødé'];
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch({ lane, test: landed });
  assert.deepEqual(sweepLines(repo, landed), [`removed worktree ${laneTree}`, `deleted ${lane} (was ${laneTip})`, 'left: none']);
  assert.deepEqual(logRecords(repo).map(({ deleted }) => [deleted.branch, deleted.reason]), [[lane, 'content-equal']]);
});

test('o: two branches at one tip are not inside each other, while a lane under them is', () => {
  const repo = makeRepo();
  const tree = addWorktree(repo, 'a', 'lane/a');
  const lowerTip = commit(tree, 'lower.txt');
  commit(tree, 'a.txt');
  git(repo, 'branch', 'lane/b', 'lane/a');
  git(repo, 'branch', 'lane/c', lowerTip);
  const hints = outputLines(tidy(['check', repo], { cwd: repo }).stdout).filter((line) => line.startsWith('in-lane? '));
  assert.deepEqual(hints, ['in-lane? lane/c all its commits are in lane/a; it goes when lane/a lands']);
});

test('n: a content-equal branch that moved between the plan and its delete to content not on the base is kept', () => {
  const { repo, laneTip } = unmergedLane();
  git(repo, 'checkout', '-q', 'lane/x', '--', 'feature.txt');
  commit(repo, 'other.txt'); // feature.txt lands on main in a commit with another patch: no patch-equal, only content
  const leftovers = findLeftovers(openRepo(repo, null)); // the plan, made while lane/x's content is on main
  assert.deepEqual(leftovers.mergedBranches.map(({ name, state }) => [name, state]), [['lane/x', 'content-equal']]);
  git(repo, 'switch', '-q', 'lane/x');
  const movedTip = commit(repo, 'new-work.txt');
  git(repo, 'switch', '-q', 'main');
  const items = pruneRepo(openRepo(repo, null), { apply: true, leftovers });
  assert.deepEqual(items.filter((entry) => entry.subject === 'lane/x').map(({ action }) => action), ['kept']);
  assert.equal(tipOf(repo, 'lane/x'), movedTip);
  assert.deepEqual(logRecords(repo), [], 'a branch that is kept is not logged');
});

// Guard: a fold whose content changed in the lane (fixup) is no content proof; the old history proof deleted it.
test('m: a folded lane whose commit the landed test branch fixed up stays, and check names it unmerged', () => {
  const { repo, laneTip } = laneFixedOnTestBranch();
  assert.deepEqual(sweepLines(repo, 'test/x'), ['left:', '  lane/x: active, ahead 1']);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  const check = outputLines(tidy(['check', repo], { cwd: repo }).stdout);
  assert.ok(check.some((line) => line.startsWith('unmerged-branch? lane/x ahead 1')), check.join('\n'));
});
