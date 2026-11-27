// Tests for what the sweep at the end of home/tools/land/land.mjs keeps and how it says so: the `left:` block (in a live lane,
// landed as patches, active, idle, `+N more`), the branches that are never deleted, a sweep skipped for a rebase in another worktree, and a
// deletion log that cannot be written safely (read-only, a folder, a FIFO, a symbolic link) or holds lines that do not parse.
// New behaviour unless a test says it is a guard: the land before the sweep printed no `left:` block, so each fails on the old
// sources. Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, backdate, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import {
  LAND, LOG_FILE, addWorktreeAt, branchExists, commitAt, land, laneSquashedOnTestBranch, logLines, logPath, logRecords, outputLines, tipOf,
} from './land-sweep-helpers.mjs';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
// Past check.mjs UNLANDED_AFTER_HOURS (2), with ten minutes to spare so the whole hours read 3.
const IDLE_MS = 3 * MS_PER_HOUR + 10 * MS_PER_MINUTE;
const MAX_LEFT_SHOWN = 20; // sweep.mjs shows this many `left:` lines, then `+N more`
const EXTRA_BRANCHES = 3;
const READ_ONLY = 0o444;
const LOG_NAME = new RegExp(LOG_FILE.replace('.', '\\.'));
const POSIX_ONLY = { skip: process.platform === 'win32' && 'no FIFOs or plain symbolic links on Windows' };
// land must end well within this when the log is a FIFO: a blocking open would hang it.
const NO_HANG_MS = 30_000;

/** Lands `branch` from `repo` and returns its output lines after the three of the landing itself (landed, worktree, branch). */
function sweepLines(repo, branch) {
  const result = land([branch, '--repo', repo, '--no-tick'], repo);
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
  const { repo, laneTree, laneTip, testTip } = laneSquashedOnTestBranch();
  commit(addWorktree(repo, 'live', 'lane/live'), 'live.txt');
  const oldTree = addWorktree(repo, 'old', 'lane/old');
  const oldTip = commitAt(oldTree, 'old.txt', 'old\n', IDLE_MS);
  git(repo, 'worktree', 'remove', oldTree);
  // lane/partial holds the folded commit and one of its own, so not all of its commits are in what landed.
  const partialTree = addWorktreeAt(repo, 'partial', 'lane/partial', 'refs/heads/lane/x');
  const partialTip = commit(partialTree, 'partial.txt');
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `removed worktree ${laneTree}`,
    `deleted lane/x (was ${laneTip})`,
    'left:',
    '  lane/live: active, ahead 1',
    '  lane/old: idle 3 h, ahead 1',
    '  lane/partial: active, ahead 2',
  ]);
  assert.deepEqual([tipOf(repo, 'main'), tipOf(repo, 'lane/old'), tipOf(repo, 'lane/partial')], [testTip, oldTip, partialTip]);
  assert.ok(branchExists(repo, 'lane/live'));
});

/**
 * Lands test/x of a squashed fold (lane/x's content lands as it is, so the sweep would delete it) with `spoil` done to the
 * deletion log first. Asserts land exits 0, says why on one stderr line naming the log, removes the landed lane, and deletes
 * nothing else: lane/x and its worktree stay. Returns the land result.
 */
function landWithUnsafeLog(spoil) {
  const { repo, laneTree, testTree, laneTip, testTip } = laneSquashedOnTestBranch();
  spoil(logPath(repo));
  const result = spawnSync(process.execPath, [LAND, 'test/x', '--repo', repo, '--no-tick'], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV, timeout: NO_HANG_MS });
  assert.equal(result.error, undefined, `land did not exit within ${NO_HANG_MS} ms`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^land: test\/x landed on main at [0-9a-f]+ and was removed; the clean-up of other branches was skipped: the deletion log .+\n$/);
  assert.match(result.stderr, LOG_NAME);
  assert.deepEqual(outputLines(result.stdout), [`landed test/x on main at ${testTip} (1 commit(s))`, `removed worktree ${testTree}`, 'deleted branch test/x']);
  assert.equal(tipOf(repo, 'lane/x'), laneTip, 'never deleted without a record');
  assert.ok(existsSync(laneTree), 'its worktree stays');
  return result;
}

test('r: a deletion log that cannot be written is said on stderr, the lane still lands with exit 0 and nothing else is deleted', () => {
  landWithUnsafeLog((path) => {
    writeFileSync(path, '');
    chmodSync(path, READ_ONLY);
    assert.throws(() => appendFileSync(path, 'x'), 'precondition: this process cannot write the log either');
  });
});

test('r: a FIFO in place of the deletion log neither hangs land nor lets it delete', POSIX_ONLY, () => {
  landWithUnsafeLog((path) => assert.equal(spawnSync('mkfifo', [path]).status, 0, 'precondition: mkfifo'));
});

test('r: a symbolic link in place of the deletion log is not followed: its target stays as it was', POSIX_ONLY, () => {
  let target;
  landWithUnsafeLog((path) => {
    target = join(path, '..', '..', '..', 'outside.txt');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, path);
  });
  assert.equal(readFileSync(target, 'utf8'), 'outside\n');
});

test('j: a rebase stopped in another worktree skips the sweep with exit 0, and a later prune deletes the folded branch', () => {
  const { repo, laneTip } = laneSquashedOnTestBranch();
  const otherTree = addWorktree(repo, 'other', 'lane/other');
  commit(otherTree, 'other.txt');
  const stopped = spawnSync('git', ['rebase', '-q', '--exec', 'exit 1', 'main'], { cwd: otherTree, encoding: 'utf8', env: CLEAN_ENV });
  assert.notEqual(stopped.status, 0, 'precondition: the rebase stopped');
  assert.deepEqual(sweepLines(repo, 'test/x'), [
    `cleanup skipped: a rebase is not finished in ${otherTree}; finish or abort it before --apply`,
    'left:',
    '  lane/other: active, ahead 1',
    '  lane/x: on main (content-equal), not removed',
  ]);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  git(otherTree, 'rebase', '--abort');
  const pruned = tidy(['prune', repo, '--apply'], { cwd: repo });
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.equal(branchExists(repo, 'lane/x'), false);
  assert.deepEqual(logRecords(repo).map(({ deleted }) => [deleted.branch, deleted.sha]), [['lane/x', laneTip]]);
});

/** The deletion record on the last line of `repo`'s log, parsed. */
const lastRecord = (repo) => JSON.parse(logLines(repo).at(-1)).deleted;

test('k: lines that do not parse in the deletion log do not stop land: the new record is appended on a line of its own', () => {
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch();
  writeFileSync(logPath(repo), 'not json\n{"landed": {"branch": "test/x"}}\n[]\n');
  assert.deepEqual(sweepLines(repo, 'test/x'), [`removed worktree ${laneTree}`, `deleted lane/x (was ${laneTip})`, 'left: none']);
  assert.deepEqual(logLines(repo).slice(0, 3), ['not json', '{"landed": {"branch": "test/x"}}', '[]']);
  assert.deepEqual([lastRecord(repo).branch, lastRecord(repo).sha], ['lane/x', laneTip]);
});

test('k: a torn last line (no newline) in the log does not swallow the record of the next deletion', () => {
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch();
  writeFileSync(logPath(repo), '{"deleted": {"branch": "old", "sha": "ab');
  assert.deepEqual(sweepLines(repo, 'test/x'), [`removed worktree ${laneTree}`, `deleted lane/x (was ${laneTip})`, 'left: none']);
  assert.equal(logLines(repo).length, 2);
  assert.deepEqual([lastRecord(repo).branch, lastRecord(repo).sha], ['lane/x', laneTip]);
});

// Repro (tess-review R3): once the owner undoes a landing, the folded branch's content is no longer on the base, so prune keeps
// it (the old history proof deleted it, and its commit was then on no branch).
test('R3: once the landing is undone (main reset back), prune --apply no longer deletes a branch that landed as it is', () => {
  const { repo, laneTree, laneTip } = laneSquashedOnTestBranch();
  const before = tipOf(repo, 'main');
  const otherTree = addWorktree(repo, 'other', 'lane/other');
  commit(otherTree, 'other.txt');
  const stopped = spawnSync('git', ['rebase', '-q', '--exec', 'exit 1', 'main'], { cwd: otherTree, encoding: 'utf8', env: CLEAN_ENV });
  assert.notEqual(stopped.status, 0, 'precondition: the rebase stopped, so the sweep is skipped');
  assert.equal(land(['test/x', '--repo', repo], repo).status, 0);
  git(repo, 'reset', '-q', '--hard', before);
  git(otherTree, 'rebase', '--abort');
  const pruned = tidy(['prune', repo, '--apply'], { cwd: repo });
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.equal(branchExists(repo, 'lane/x'), true, pruned.stdout);
  assert.equal(tipOf(repo, 'lane/x'), laneTip);
  assert.ok(existsSync(laneTree), 'its worktree stays');
});

// Repro (tess-review R4): the spec says land exits 0 once the lane has landed, with the problem on stderr (the old sources
// stopped the clean-up with EISDIR and exited 1).
test('R4: a deletion log that cannot be opened (a folder in its place) still lands and removes the lane with exit 0', () => {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', 'lane/l');
  const laneTip = commit(laneTree, 'lane.txt');
  mkdirSync(logPath(repo));
  const result = land(['lane/l', '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, LOG_NAME);
  assert.equal(tipOf(repo, 'main'), laneTip);
  assert.equal(branchExists(repo, 'lane/l'), false);
  assert.equal(existsSync(laneTree), false);
});

const SHORT_HASH_LENGTH = 8; // sweep.mjs names the base commit by this many hex digits

/** The `left:` line sweep.mjs prints for `name`, whose whole content was on main at `pairedBase`. */
const landedLine = (name, pairedBase) =>
  `  ${name}: landed in ${pairedBase.slice(0, SHORT_HASH_LENGTH)} (its content was on main there); main changed its files since: look (git log -p main..${name}), then git branch -D ${name}`;

test('l: a fold that landed by cherry-pick, whose lines main changed since, is labelled landed in <C> and stays', () => {
  const repo = makeRepo();
  commit(repo, 'shared.txt', 'one\ntwo\n');
  const testTree = addWorktree(repo, 'test', 'test/t');
  const testTip = commit(testTree, 'shared.txt', 'one\nfixed\n');
  git(addWorktree(repo, 'lane', 'lane/l'), 'cherry-pick', '-x', testTip); // -x: a commit of its own, not test/t's again
  sweepLines(repo, 'lane/l'); // test/t is kept here only because its worktree was just used
  const pairedBase = tipOf(repo, 'main');
  git(repo, 'worktree', 'remove', testTree);
  commit(addWorktree(repo, 'more', 'lane/m'), 'shared.txt', 'one\nfixed again\n');
  assert.deepEqual(sweepLines(repo, 'lane/m'), ['left:', landedLine('test/t', pairedBase)]);
  assert.equal(tipOf(repo, 'test/t'), testTip);
});

// Guard (plan D2): patch ids leave out line numbers, so R2's test commit pairs with the lane's commit at the other place;
// a later change to the same file must not turn that pairing into a label (it would advise deleting unlanded work).
test('l: R2, then main changes shared.txt elsewhere: the patch-id pair is no proof, test/T stays active, ahead 1', () => {
  const repo = makeRepo();
  const twice = `${['a', 'b', 'c', 'd', 'e', 'f'].join('\n')}\n`; // the same lines twice, so both places have one context
  commit(repo, 'shared.txt', `${twice}g\nh\n${twice}`);
  const testTree = addWorktree(repo, 'test', 'test/T');
  const testTip = commit(testTree, 'shared.txt', `a\nb\nc\nNEW\nd\ne\nf\ng\nh\n${twice}`);
  commit(addWorktree(repo, 'lane', 'lane/L'), 'shared.txt', `${twice}g\nh\na\nb\nc\nNEW\nd\ne\nf\n`);
  backdate(testTree);
  assert.deepEqual(sweepLines(repo, 'lane/L'), ['left:', '  test/T: active, ahead 1']);
  commit(addWorktree(repo, 'more', 'lane/M'), 'shared.txt', `${twice}G\nh\na\nb\nc\nNEW\nd\ne\nf\n`);
  assert.equal(git(repo, 'rev-list', '--right-only', '--cherry-mark', 'main...test/T'), `=${testTip}`, 'precondition: its commit pairs with one on main');
  assert.deepEqual(sweepLines(repo, 'lane/M'), ['left:', '  test/T: active, ahead 1']);
  assert.equal(tipOf(repo, 'test/T'), testTip);
});

test('l: a branch with one commit that landed by cherry-pick and one that has no equal patch on main gets no label', () => {
  const repo = makeRepo();
  const testTree = addWorktree(repo, 'test', 'test/t');
  const pickedTip = commit(testTree, 'picked.txt');
  const testTip = commit(testTree, 'own.txt', 'own\n');
  // The lane holds own.txt as it is, but with another file in the same commit, so that commit's patch id differs; the
  // cherry-pick comes last, so all of test/t's content is on main at the newest paired commit and only the rule "every
  // commit has an equal patch" keeps the label off.
  const laneTree = addWorktree(repo, 'lane', 'lane/l');
  writeFileSync(join(laneTree, 'own.txt'), 'own\n');
  git(laneTree, 'add', '--', 'own.txt');
  commit(laneTree, 'extra.txt'); // commits own.txt and extra.txt together
  git(laneTree, 'cherry-pick', pickedTip);
  sweepLines(repo, 'lane/l'); // test/t is kept here only because its worktree was just used
  git(repo, 'worktree', 'remove', testTree);
  commit(addWorktree(repo, 'more', 'lane/m'), 'own.txt', 'own, changed\n');
  assert.deepEqual(sweepLines(repo, 'lane/m'), ['left:', '  test/t: active, ahead 1']);
  assert.equal(tipOf(repo, 'test/t'), testTip);
});
