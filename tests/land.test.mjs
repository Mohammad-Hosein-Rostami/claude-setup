// Tests for home/tools/land/land.mjs: a lane is rebased onto the base, the base checkout is fast-forwarded to it and the lane's
// worktree (unlocked first) and branch are deleted; a dirty base checkout, a rebase conflict and bad arguments change nothing.
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'feat/lane';

const land = (args, cwd) => spawnSync(process.execPath, [LAND, ...args], { cwd, encoding: 'utf8', env: CLEAN_ENV });
const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

/** A repo whose lane (own worktree, one commit) is behind a base that moved on by one commit. */
function laneBehindBase({ laneFile = 'lane.txt', laneText = 'lane', baseFile = 'other.txt', baseText = 'other' } = {}) {
  const repo = makeRepo();
  const worktree = addWorktree(repo, 'lane', LANE);
  commit(worktree, laneFile, laneText);
  commit(repo, baseFile, baseText);
  return { repo, worktree };
}

test('a lane in a locked worktree is rebased onto the moved base, fast-forwarded, and its worktree and branch are deleted', () => {
  const { repo, worktree } = laneBehindBase();
  git(repo, 'worktree', 'lock', worktree);
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(result.stdout.trim().split('\n'), [`landed ${LANE} on main at ${tip} (1 commit(s))`, `removed worktree ${worktree}`, `deleted branch ${LANE}`]);
  assert.equal(git(repo, 'log', '--merges', '--oneline', 'main'), '', 'no merge commit');
  assert.equal(git(repo, 'rev-list', '--count', 'main'), '3', 'base, the base commit and the rebased lane commit on one line');
  assert.ok(existsSync(join(repo, 'lane.txt')) && existsSync(join(repo, 'other.txt')), 'the base checkout holds both commits');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(existsSync(worktree), false, 'the locked worktree is unlocked and removed');
  assert.equal(branchExists(repo, LANE), false);
});

test('a dirty base checkout is refused before anything changes', () => {
  const { repo, worktree } = laneBehindBase();
  const [base, lane] = [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', LANE)];
  writeFileSync(join(repo, 'base.txt'), 'edited');
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^land: the base checkout \(.+\) has 1 changed or untracked file\(s\); commit or move them first/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', LANE)], [base, lane]);
  assert.ok(existsSync(worktree));
});

test('a rebase conflict is aborted: the lane, its worktree and the base stay as they were', () => {
  const { repo, worktree } = laneBehindBase({ laneFile: 'base.txt', laneText: 'lane side', baseFile: 'base.txt', baseText: 'base side' });
  const [base, lane] = [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', LANE)];
  const result = land([LANE, '--repo', repo], repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the rebase of feat\/lane onto main stopped \(.+\); it was aborted, so feat\/lane is as it was\. Rebase it by hand/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', LANE)], [base, lane]);
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'no rebase left half done');
  assert.equal(existsSync(join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), false);
});

test('a branch with no worktree is rebased in the base checkout, which ends on the base again', () => {
  const repo = makeRepo();
  const worktree = addWorktree(repo, 'plain', 'feat/plain');
  commit(worktree, 'plain.txt');
  git(repo, 'worktree', 'remove', worktree);
  commit(repo, 'other.txt');
  const result = land(['feat/plain'], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^landed feat\/plain on main at [0-9a-f]{40} \(1 commit\(s\)\)\ndeleted branch feat\/plain\n$/);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(repo, 'plain.txt')));
});

test('bad arguments, an unknown branch and the base itself are refused with a clear message', () => {
  const repo = makeRepo();
  const usage = /usage: node ~\/\.claude\/tools\/land\/land\.mjs <branch> \[--repo <path>\]/;
  for (const args of [[], ['a', 'b'], ['--force', 'a'], ['a', '--repo']]) {
    const result = land(args, repo);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, usage);
  }
  const unknown = land(['nope'], repo);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^land: there is no branch nope in /);
  assert.match(land(['main'], repo).stderr, /^land: main is the base checked out in .+; name the lane branch to land/);
  assert.match(land(['x', '--repo', join(repo, 'missing')], repo).stderr, /^land: .+missing is not a folder/);
});
