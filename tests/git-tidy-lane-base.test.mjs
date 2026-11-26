// Tests of `git-tidy lane claim` and the base (lib/lane-pool.mjs, lane-cli.mjs): with no --base a claim starts at the tip of the
// branch checked out in the main checkout, records that base (`branch.<lane>.cs-lane-base`) and marks it (`branch.<base>.cs-base`);
// a new branch's --base must be on the base; a branch recorded on another base is refused; a record that cannot be written fails
// the claim with nothing handed out; a snapshot records nothing. Every repo is a temp repo (git-tidy-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { claim, lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const claimNoBase = (repo, branch, env) => lane(['claim', '--repo', repo, '--branch', branch, '--json'], env);
/** The value of a git config key, or null when it is not set. */
const configOf = (repo, key) => {
  const read = spawnSync('git', ['config', '--get', key], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV });
  return read.status === 0 ? read.stdout.trim() : null;
};
const branchExists = (repo, branch) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

test('claim with no --base starts at the base tip, records the base and marks it', () => {
  const repo = makeRepo();
  const tip = head(repo);
  const result = claimNoBase(repo, 'lane/a', laneEnv());
  assert.equal(result.status, 0, result.stderr);
  const claimed = JSON.parse(result.stdout);
  assert.equal(claimed.base, tip);
  assert.equal(claimed.baseBranch, 'main');
  assert.equal(head(poolPath(repo, 1)), tip);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), 'main');
  assert.equal(configOf(repo, 'branch.main.cs-base'), 'true');
});

test('the record names the branch checked out in the main checkout (develop)', () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'develop');
  const tip = commit(repo, 'develop.txt');
  const result = claimNoBase(repo, 'lane/a', laneEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(head(poolPath(repo, 1)), tip);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), 'develop');
  assert.equal(configOf(repo, 'branch.develop.cs-base'), 'true');
});

test('--base with a full sha on the base still works (old callers)', () => {
  const repo = makeRepo();
  const older = head(repo);
  commit(repo, 'newer.txt');
  const result = claim(repo, 'lane/a', older, laneEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(head(poolPath(repo, 1)), older);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), 'main');
});

test('a new branch whose --base is only on a side branch is refused, nothing made', () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'side');
  const sideOnly = commit(repo, 'side.txt');
  git(repo, 'switch', '-q', 'main');
  const result = claim(repo, 'lane/a', sideOnly, laneEnv());
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp(`--base ${sideOnly} is not on main \\(the branch checked out in the main checkout\\)`));
  assert.equal(branchExists(repo, 'lane/a'), false);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), null);
});

test('claim of an existing branch records the base and keeps its tip', () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'test/x');
  const testTip = commit(repo, 'test.txt');
  git(repo, 'switch', '-q', 'main');
  const result = claimNoBase(repo, 'test/x', laneEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(head(poolPath(repo, 1)), testTip);
  assert.equal(configOf(repo, 'branch.test/x.cs-lane-base'), 'main');
});

test('an existing branch recorded on another base is refused and keeps its record', () => {
  const repo = makeRepo();
  git(repo, 'branch', 'lane/a');
  git(repo, 'config', 'branch.lane/a.cs-lane-base', 'develop');
  const result = claimNoBase(repo, 'lane/a', laneEnv());
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /lane\/a was claimed on develop, but the main checkout has main checked out: switch back to develop there/);
  assert.match(result.stderr, /git config branch\.lane\/a\.cs-lane-base main\) and claim again/);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), 'develop');
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /cs-lane-pool lane\/a/);
});

test('a record left for a branch that does not exist (a failed claim) is written over', () => {
  const repo = makeRepo();
  git(repo, 'config', 'branch.lane/a.cs-lane-base', 'develop');
  const result = claimNoBase(repo, 'lane/a', laneEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(configOf(repo, 'branch.lane/a.cs-lane-base'), 'main');
});

test('--snapshot with no --base is detached at the base tip and records nothing', () => {
  const repo = makeRepo();
  const tip = head(repo);
  const result = lane(['claim', '--repo', repo, '--snapshot', '--json'], laneEnv());
  assert.equal(result.status, 0, result.stderr);
  const claimed = JSON.parse(result.stdout);
  assert.equal(claimed.base, tip);
  assert.equal(claimed.baseBranch, null);
  const folder = poolPath(repo, 1);
  assert.equal(head(folder), tip);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: folder, env: CLEAN_ENV }).status, 1); // detached
  assert.equal(spawnSync('git', ['config', '--get-regexp', '\\.cs-lane-base$'], { cwd: repo, env: CLEAN_ENV }).status, 1);
});

test('a held config.lock fails the claim (exit 14): no lane branch and no locked folder', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.git', 'config.lock'), ''); // another git writing the config
  const result = claimNoBase(repo, 'lane/b', laneEnv());
  assert.equal(result.status, 14, result.stderr);
  assert.match(result.stderr, /git config branch\.lane\/b\.cs-lane-base failed/);
  assert.equal(branchExists(repo, 'lane/b'), false);
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /cs-lane-pool lane\/b/);
});
