// Tests for `git-tidy land`: rebase a lane onto the base, require a suite PASS on the rebased tip, fast-forward the base, and clean up.
// The PASS lookup is the one outside part (test-pass), so in-process tests hand `landLane` a fake `hasPass`; the CLI tests cover the
// outcomes that never reach it (usage, conflict, no record). Every repo is built in a temp folder (git-tidy-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { landLane } from '../home/tools/git-tidy/lib/land.mjs';
import { formatLand, landExitCode } from '../home/tools/git-tidy/lib/report.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const passAlways = () => true;
const land = (dir, branch, options = {}) => landLane(openRepo(dir, null), branch, { hasPass: passAlways, ...options });
const branchNames = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

/** A lane with one commit off main, main moved on afterwards; the lane is checked out in its own worktree. */
function laneWithWorktree() {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/x');
  commit(dir, 'lane.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved.txt');
  const worktree = addWorktree(dir, 'wt-x', 'lane/x', { create: false });
  return { dir, worktree };
}

test('landing rebases the lane, fast-forwards the base and removes the lane worktree, branch, helper branch and older copy', () => {
  const { dir, worktree } = laneWithWorktree();
  git(dir, 'branch', 'lane/x--fix-agent', 'lane/x');
  git(dir, 'checkout', '-q', '-b', 'lane/x-2', 'main');
  git(dir, 'cherry-pick', 'lane/x');
  git(dir, 'checkout', '-q', 'main');
  const result = land(dir, 'lane/x');
  assert.equal(result.status, 'landed');
  assert.equal(git(dir, 'rev-parse', 'main'), result.tip);
  assert.equal(git(dir, 'rev-list', '--merges', '--count', 'main'), '0');
  assert.equal(git(dir, 'log', '--format=%s', '-1', 'main'), 'add lane.txt');
  assert.ok(!existsSync(worktree), 'the lane worktree is removed');
  assert.deepEqual(branchNames(dir), ['main'], 'the lane, its helper and the older copy are deleted');
  assert.equal(result.findings.length, 0);
  assert.ok(result.removed.some((entry) => entry.includes('lane/x-2')));
  assert.match(formatLand(result, false), /\bcheck: clean\b/);
  assert.equal(landExitCode(result), 0);
});

test('a lane that no worktree holds is rebased in a temporary worktree that is gone afterwards', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/solo');
  commit(dir, 'solo.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved.txt');
  const result = land(dir, 'lane/solo');
  assert.equal(result.status, 'landed');
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
  assert.deepEqual(branchNames(dir), ['main']);
});

test('the PASS lookup gets the rebased tip and asks for the suite command', () => {
  const { dir } = laneWithWorktree();
  const calls = [];
  const hasPass = (repoDir, rev, options) => { calls.push({ rev, options }); return false; };
  const result = land(dir, 'lane/x', { hasPass });
  assert.equal(result.status, 'no-pass');
  assert.equal(landExitCode(result), 4);
  assert.deepEqual(calls.map((call) => call.options), [{ suite: true }]);
  assert.equal(calls[0].rev, result.tip);
  assert.equal(git(dir, 'rev-parse', 'lane/x'), result.tip, 'the lane is rebased onto main');
  assert.notEqual(git(dir, 'rev-parse', 'main'), result.tip, 'the base did not move');
});

// An empty home and no session id: no switch file is read, so the `test` check is off unless the command line adds it (home/hooks/lib/checks-on.mjs).
const noSwitchEnv = () => {
  const home = makeTempDir('git-tidy-land-home-');
  return { HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
};

test('no PASS record: exit 4 and the base is untouched (CLI, `test` check on)', () => {
  const { dir } = laneWithWorktree();
  const before = git(dir, 'rev-parse', 'main');
  const result = tidy(['land', 'lane/x', dir, '--checks', 'test'], { cwd: dir, env: noSwitchEnv() });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(git(dir, 'rev-parse', 'main'), before);
  assert.ok(branchNames(dir).includes('lane/x'));
});

test('with the `test` check off the CLI lands a lane that has no PASS record (exit 0)', () => {
  const { dir } = laneWithWorktree();
  const result = tidy(['land', 'lane/x', dir], { cwd: dir, env: noSwitchEnv() });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(branchNames(dir), ['main'], 'the lane is landed and deleted');
  assert.equal(git(dir, 'log', '--format=%s', '-1', 'main'), 'add lane.txt');
});

test('a conflict aborts the rebase, names the file and exits 3', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/c');
  commit(dir, 'same.txt', 'lane version\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'same.txt', 'main version\n');
  const laneTip = git(dir, 'rev-parse', 'lane/c');
  const result = tidy(['land', 'lane/c', dir], { cwd: dir });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /same\.txt/);
  assert.equal(git(dir, 'rev-parse', 'lane/c'), laneTip, 'the lane is where it was');
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'no temporary worktree is left');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a tracked change in the base folder exits 2 naming the file, before any change', () => {
  const { dir } = laneWithWorktree();
  writeFileSync(join(dir, 'base.txt'), 'edited');
  const laneTip = git(dir, 'rev-parse', 'lane/x');
  const result = tidy(['land', 'lane/x', dir], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /base\.txt/);
  assert.equal(git(dir, 'rev-parse', 'lane/x'), laneTip, 'the lane was not rebased');
});

test('an untracked file in the base folder does not block the landing and is left byte-equal', () => {
  const { dir } = laneWithWorktree();
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'my notes\n');
  const before = readFileSync(notes);
  assert.equal(land(dir, 'lane/x').status, 'landed');
  assert.deepEqual(readFileSync(notes), before);
  assert.equal(git(dir, 'status', '--porcelain'), '?? notes.txt');
});

test('an untracked file the merge would overwrite exits 2 naming it, and nothing changes', () => {
  const { dir } = laneWithWorktree();
  writeFileSync(join(dir, 'lane.txt'), 'untracked and in the way\n');
  const [mainTip, laneTip] = [git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'lane/x')];
  const result = tidy(['land', 'lane/x', dir], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lane\.txt/);
  assert.deepEqual([git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'lane/x')], [mainTip, laneTip]);
  assert.equal(readFileSync(join(dir, 'lane.txt'), 'utf8'), 'untracked and in the way\n');
});

test('a base that moves between the PASS check and the merge is exit 5', () => {
  const { dir } = laneWithWorktree();
  const moveBase = () => { commit(dir, 'late.txt'); return true; };
  const result = land(dir, 'lane/x', { hasPass: moveBase });
  assert.equal(result.status, 'base-moved');
  assert.equal(landExitCode(result), 5);
  assert.ok(branchNames(dir).includes('lane/x'), 'the lane stays so the landing can be rerun');
});

test('--rebase-only rebases, prints the tip and the number of changed patches, and lands nothing', () => {
  const dir = makeRepo();
  commit(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n');
  git(dir, 'checkout', '-q', '-b', 'lane/p');
  commit(dir, 'f.txt', 'l1\nl2\nl3\nl4\nLANE\nl6\nl7\nl8\nl9\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'f.txt', 'l1\nl2\nMAIN\nl4\nl5\nl6\nl7\nl8\nl9\n');
  const mainTip = git(dir, 'rev-parse', 'main');
  const result = tidy(['land', 'lane/p', dir, '--rebase-only'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [`tip ${git(dir, 'rev-parse', 'lane/p')}`, 'patches-changed 1']);
  assert.equal(git(dir, 'rev-parse', 'main'), mainTip);
});

test('--rebase-only of a lane that rebases without any context change reports 0 changed patches', () => {
  const { dir } = laneWithWorktree();
  const result = tidy(['land', 'lane/x', dir, '--rebase-only'], { cwd: dir });
  assert.match(result.stdout, /patches-changed 0/);
});

test('findings left after landing give exit 1 and are printed', () => {
  const { dir } = laneWithWorktree();
  git(dir, 'checkout', '-q', '-b', 'other');
  commit(dir, 'other.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'a merge commit', 'other'); // a merge commit on main is a finding that land cannot fix
  git(dir, 'branch', '-D', 'other');
  const result = land(dir, 'lane/x');
  assert.equal(result.status, 'landed');
  assert.ok(result.findings.some((finding) => finding.kind === 'merge-commit'));
  assert.equal(landExitCode(result), 1);
  assert.doesNotMatch(formatLand(result, false), /check: clean/);
});

test('an unknown lane, and the base itself, are usage errors (exit 2)', () => {
  const { dir } = laneWithWorktree();
  assert.equal(tidy(['land', 'no-such-lane', dir], { cwd: dir }).status, 2);
  assert.equal(tidy(['land', 'main', dir], { cwd: dir }).status, 2);
});

test('the base gets the commit the PASS was found for, not a commit added to the lane meanwhile', () => {
  const { dir, worktree } = laneWithWorktree();
  const commitDuringLookup = () => { commit(worktree, 'late.txt'); return true; };
  const result = land(dir, 'lane/x', { hasPass: commitDuringLookup });
  assert.equal(git(dir, 'rev-parse', 'main'), result.tip, 'main is the tested tip');
  assert.equal(git(dir, 'ls-tree', '--name-only', 'main', '--', 'late.txt'), '', 'the untested commit is not on main');
  assert.ok(branchNames(dir).includes('lane/x'), 'the lane keeps its extra commit');
});

test('cleanup after a landing keeps another lane\'s recently used worktree (only the landed lane skips the 60-minute rule)', () => {
  const { dir } = laneWithWorktree();
  git(dir, 'checkout', '-q', '-b', 'lane/other');
  commit(dir, 'other.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'lane/other');
  const inUse = addWorktree(dir, 'wt-other', 'lane/other', { create: false });
  const result = land(dir, 'lane/x');
  assert.equal(result.status, 'landed');
  assert.ok(existsSync(inUse), 'a worktree somebody may be using is not the landed lane\'s to remove');
  assert.ok(!result.removed.some((entry) => entry.includes('wt-other')));
});

test('a cleanup that must refuse after the fast-forward still reports the landing (exit 1 with the leftovers), not a usage error', () => {
  const { dir, worktree } = laneWithWorktree();
  const unfinishedElsewhere = addWorktree(dir, 'wt-busy', 'busy');
  const startMerge = () => { writeFileSync(join(git(unfinishedElsewhere, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'main')}\n`); return true; };
  const result = land(dir, 'lane/x', { hasPass: startMerge });
  assert.equal(result.status, 'landed');
  assert.equal(git(dir, 'rev-parse', 'main'), result.tip, 'main moved');
  assert.match(result.cleanupRefused, /merge is not finished/);
  assert.ok(existsSync(worktree), 'nothing was removed');
  assert.equal(landExitCode(result), 1);
  assert.match(formatLand(result, false), /cleanup skipped: .*merge is not finished/);
});
