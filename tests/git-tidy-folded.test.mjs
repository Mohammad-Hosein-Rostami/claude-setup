// Tests for git-tidy's folded-branch proof (home/tools/git-tidy/lib/folded.mjs, landed-log.mjs) as `land`, `check` and
// `prune --apply` use it: a folded branch whose worktree holds work or is in use is kept with the reason and deleted by a later
// prune once it is free; a branch that moved on is no longer folded; log lines that are no record prove nothing; two branches
// at one tip are not inside each other; branch names git allows pass through as they are.
// New behaviour unless a test says it is a guard (the old sources had no folded proof): each fails on the old sources.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findLeftovers } from '../home/tools/git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../home/tools/git-tidy/lib/prune.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { CLEAN_ENV, addWorktree, backdate, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import {
  branchExists, land, laneFixedOnTestBranch, logPath, logRecords, outputLines, tipOf, usedAgo,
} from './land-sweep-helpers.mjs';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const LOG_DAYS = 30; // landed-log.mjs MAX_AGE_DAYS: older landings are not read
const IN_USE = 'used 5 min ago (an agent may still work there)';
const BUSY = '1 uncommitted or untracked files';
const LOCKED = 'locked; unlock it with `git worktree unlock` first';
const NOT_FOLDED = 'it moved, or its landing record no longer proves it folded';
const MAX_LINE_COMMITS = 500; // landed-log.mjs: over this many commits a landing keeps no patch ids (ancestry only)
const MS_PER_SECOND = 1000;

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
const landedRecord = (repo, branch) => logRecords(repo).find((record) => record.landed?.branch === branch)?.landed;

/** Plan case g: the folded lane/x's worktree is spoiled before the land, kept with `reason`, cleaned, then pruned. */
function keptUntilClean(spoil, clean, reason) {
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch();
  spoil(laneTree);
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `kept ${laneTree}: ${reason}`,
    `kept lane/x: checked out in ${laneTree}`,
    'left:',
    `  lane/x: kept: ${reason}`,
  ]);
  assert.ok(landedRecord(repo, 'test/x').shas.includes(laneTip), 'the proof stays in the landing log');
  clean(laneTree);
  backdate(laneTree); // cleaning touched its files; the worktree was last used before the landing
  applyPrune(repo);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.equal(existsSync(laneTree), false);
}

test('g: a folded branch whose worktree has an uncommitted edit is kept, then deleted by prune --apply once it is clean', () => {
  keptUntilClean((tree) => writeFileSync(join(tree, 'feature.txt'), 'unsaved edit\n'), (tree) => git(tree, 'checkout', '--', 'feature.txt'), BUSY);
});

test('g: a folded branch whose worktree has an untracked file is kept, then deleted by prune --apply once it is gone', () => {
  keptUntilClean((tree) => writeFileSync(join(tree, 'notes.txt'), 'draft\n'), (tree) => rmSync(join(tree, 'notes.txt')), BUSY);
});

test('g: a folded branch whose worktree is locked is kept, then deleted by prune --apply once it is unlocked', () => {
  keptUntilClean((tree) => git(tree, 'worktree', 'lock', tree), (tree) => git(tree, 'worktree', 'unlock', tree), LOCKED);
});

test('h: a folded branch that got a new commit after the landing is no longer folded and stays', () => {
  const { repo, laneTree } = laneFixedOnTestBranch();
  writeFileSync(join(laneTree, 'feature.txt'), 'more work\n');
  sweepLines(repo, 'test/x');
  const before = outputLines(tidy(['check', repo], { cwd: repo }).stdout);
  assert.ok(before.some((line) => line.startsWith('folded-branch lane/x ') && line.includes(' folded into test/x (landed ')), before.join('\n'));
  git(laneTree, 'commit', '-q', '-a', '-m', 'more work after the landing');
  const newTip = tipOf(repo, 'lane/x');
  backdate(laneTree);
  const after = outputLines(tidy(['check', repo], { cwd: repo }).stdout);
  assert.equal(after.some((line) => line.startsWith('folded-branch ')), false, after.join('\n'));
  applyPrune(repo);
  assert.equal(tipOf(repo, 'lane/x'), newTip);
});

test('i: a folded worktree used after the landed lane\'s last commit is kept; used only before that commit it is removed', () => {
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch({ msAgo: 20 * MS_PER_MINUTE });
  usedAgo(laneTree, 5 * MS_PER_MINUTE);
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `kept ${laneTree}: ${IN_USE}`,
    `kept lane/x: checked out in ${laneTree}`,
    'left:',
    `  lane/x: kept: ${IN_USE}`,
  ]);
  // Within the 60 minutes, but before the lane's last commit: left behind when the work moved on.
  usedAgo(laneTree, 30 * MS_PER_MINUTE);
  const pruned = outputLines(applyPrune(repo).stdout);
  assert.ok(pruned.some((line) => line.includes(laneTree)), pruned.join('\n'));
  assert.equal(existsSync(laneTree), false);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.deepEqual(logRecords(repo).filter((record) => record.deleted).map(({ deleted }) => deleted.sha), [laneTip]);
});

/** A repo with an unmerged branch lane/x (one commit, no worktree) and a landing record whose fields are `fields`. */
function laneAndRecord(fields = {}) {
  const repo = makeRepo();
  const base = tipOf(repo, 'main');
  git(repo, 'switch', '-q', '-c', 'lane/x');
  const laneTip = commit(repo, 'feature.txt');
  git(repo, 'switch', '-q', 'main');
  const record = { branch: 'test/x', tip: laneTip, shas: [laneTip], patchIds: null, lastCommitMs: Date.now(), base: 'main', landedTip: base, landedAt: Date.now(), ...fields };
  return { repo, laneTip, line: JSON.stringify({ landed: record }) };
}

test('k: a well-formed landing record proves the fold and prune --apply deletes the branch (the control of the next test)', () => {
  const { repo, line } = laneAndRecord();
  writeFileSync(logPath(repo), `${line}\n`);
  applyPrune(repo);
  assert.equal(branchExists(repo, 'lane/x'), false);
});

// Guard: the old sources read no log at all, so this passes there too; the control above shows these records would count.
test('k: an empty log, lines that do not parse, records of the wrong shape and records past 30 days delete nothing', () => {
  const { repo, laneTip, line } = laneAndRecord();
  const broken = [
    '',
    'not json',
    line.slice(0, -10),
    JSON.stringify({ landed: { ...JSON.parse(line).landed, shas: ['not-a-hash'] } }),
    JSON.stringify({ landed: { ...JSON.parse(line).landed, landedAt: 'yesterday' } }),
    laneAndRecord({ landedAt: Date.now() - (LOG_DAYS + 1) * MS_PER_DAY, shas: [laneTip] }).line,
  ];
  for (const text of broken) {
    writeFileSync(logPath(repo), text === '' ? '' : `${text}\n`);
    const result = applyPrune(repo);
    assert.equal(result.stderr, '', text);
    assert.equal(tipOf(repo, 'lane/x'), laneTip, text);
  }
});

test('l: branch names git allows (a/b.c, unicode) are proven, deleted and printed as they are', () => {
  const [lane, landed] = ['a/b.c', 'test/ünï-çødé'];
  const { repo, laneTree, laneTip } = laneFixedOnTestBranch({ lane, test: landed });
  assert.deepEqual(sweepLines(repo, landed), [`removed worktree ${laneTree}`, `deleted ${lane} (was ${laneTip}, folded into ${landed})`, 'left: none']);
  assert.deepEqual(logRecords(repo).filter((record) => record.deleted).map(({ deleted }) => [deleted.branch, deleted.reason]), [[lane, `folded into ${landed}`]]);
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

test('n: a folded branch that moved between the plan and its delete is kept, even when the new tip is folded too', () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'lane/x');
  const firstTip = commit(repo, 'feature.txt');
  const laneTip = commit(repo, 'feature-more.txt');
  git(repo, 'switch', '-q', 'main');
  const record = { branch: 'test/x', tip: laneTip, shas: [laneTip], patchIds: null, lastCommitMs: Date.now(), base: 'main', landedTip: tipOf(repo, 'main'), landedAt: Date.now() };
  writeFileSync(logPath(repo), `${JSON.stringify({ landed: record })}\n`);
  const leftovers = findLeftovers(openRepo(repo, null)); // the plan, made while lane/x is at laneTip
  git(repo, 'update-ref', 'refs/heads/lane/x', firstTip, laneTip);
  const items = pruneRepo(openRepo(repo, null), { apply: true, leftovers });
  assert.deepEqual(items.filter((entry) => entry.subject === 'lane/x'), [{ action: 'kept', kind: 'folded-branch', subject: 'lane/x', detail: NOT_FOLDED }]);
  assert.equal(tipOf(repo, 'lane/x'), firstTip);
});

/** Appends `count` commits (one file changed each, dated now) to `branch`, which starts at `from`, in one fast-import. */
function importCommits(repo, branch, from, count) {
  const when = `${Math.floor(Date.now() / MS_PER_SECOND)} +0000`;
  const blocks = Array.from({ length: count }, (_, i) => {
    const message = `line commit ${i}`;
    const text = `${message}\n`;
    return [`commit refs/heads/${branch}`, `committer t <t@t> ${when}`, `data ${message.length}`, message, ...(i === 0 ? [`from ${from}`] : []), 'M 100644 inline line.txt', `data ${text.length}`, text].join('\n');
  });
  const result = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV, input: `${blocks.join('\n')}\n` });
  assert.equal(result.status, 0, result.stderr);
}

// The kept branch is a guard (nothing deleted it on the old sources); only the `left:` line fails there.
test('m: a lane of more than 500 commits is proven by ancestry only, so a cherry-picked and amended fold of it stays', () => {
  const repo = makeRepo();
  const testTree = addWorktree(repo, 'test', 'test/t');
  const testTip = commit(testTree, 'shared.test.txt', 'first check\n');
  git(repo, 'worktree', 'remove', testTree);
  importCommits(repo, 'lane/l', tipOf(repo, 'main'), MAX_LINE_COMMITS);
  const laneTree = join(repo, '..', 'lane');
  git(repo, 'worktree', 'add', '-q', laneTree, 'lane/l');
  git(laneTree, 'cherry-pick', testTip);
  writeFileSync(join(laneTree, 'shared.test.txt'), 'amended check\n');
  git(laneTree, 'commit', '-q', '-a', '--amend', '--no-edit');
  assert.deepEqual(sweepLines(repo, 'lane/l'), ['left:', '  test/t: active, ahead 1']);
  assert.equal(tipOf(repo, 'test/t'), testTip);
  assert.equal(landedRecord(repo, 'lane/l').patchIds, null);
});
