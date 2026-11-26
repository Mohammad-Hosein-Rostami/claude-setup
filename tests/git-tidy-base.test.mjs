// Tests for git-tidy's base rule: the base is the branch checked out in the main checkout (no origin/HEAD, no name list),
// a main checkout with no branch or with a lane checked out stops with the fix step, and every base branch (the base, a
// branch marked `branch.<b>.cs-base`, a remote's HEAD branch) is never deleted or claimed.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLeftovers } from '../home/tools/git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../home/tools/git-tidy/lib/prune.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { addWorktree, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { branchExists, land } from './land-sweep-helpers.mjs';
import { laneEnv } from './git-tidy-lane-pool-helpers.mjs';

const check = (dir, ...extra) => tidy(['check', dir, ...extra], { cwd: dir });
const prune = (dir, ...extra) => tidy(['prune', dir, '--include-recent', ...extra], { cwd: dir });

/** `origin/HEAD` points at `origin/<branch>`, as after a clone whose default branch is `branch` (no remote needed). */
function setOriginHead(dir, branch) {
  git(dir, 'update-ref', `refs/remotes/origin/${branch}`, branch);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
}

/** A repo whose main checkout is on `feature/x`, made from `develop` with one commit; `develop` is an ancestor of it. */
function featureFromDevelop() {
  const dir = makeRepo();
  git(dir, 'branch', '-m', 'main', 'develop');
  git(dir, 'switch', '-q', '-c', 'feature/x');
  commit(dir, 'feature.txt');
  return dir;
}

// The bug this rule fixes: land's sweep prunes against the checked-out branch, and a merged local develop was deleted.
test('repro: landing a lane on feature/x keeps the develop it was made from (origin/HEAD points at it)', () => {
  const dir = featureFromDevelop();
  setOriginHead(dir, 'develop');
  const lane = addWorktree(dir, 'lane', 'lane/a');
  commit(lane, 'lane.txt');
  const result = land(['lane/a', '--repo', dir], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(branchExists(dir, 'develop'), `develop was deleted:\n${result.stdout}`);
});

test('repro: landing a lane on feature/x keeps a develop marked as a base', () => {
  const dir = featureFromDevelop();
  git(dir, 'config', 'branch.develop.cs-base', 'true');
  const lane = addWorktree(dir, 'lane', 'lane/a');
  commit(lane, 'lane.txt');
  const result = land(['lane/a', '--repo', dir], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(branchExists(dir, 'develop'), `develop was deleted:\n${result.stdout}`);
});

test('the base is the branch checked out in the main checkout, not origin/HEAD and not main', () => {
  const dir = makeRepo();
  setOriginHead(dir, 'main');
  git(dir, 'switch', '-q', '-c', 'develop');
  assert.equal(lines(check(dir))[0], 'base: develop (checked out)');
});

test('the same base from a linked worktree on a lane', () => {
  const dir = makeRepo();
  setOriginHead(dir, 'main');
  git(dir, 'switch', '-q', '-c', 'develop');
  const lane = addWorktree(dir, 'lane', 'lane/a');
  assert.equal(lines(tidy(['check', lane], { cwd: lane }))[0], 'base: develop (checked out)');
});

test('a detached main checkout stops check and prune with exit 2 and the fix step', () => {
  const dir = makeRepo();
  git(dir, 'switch', '-q', '--detach');
  for (const result of [check(dir), prune(dir), prune(dir, '--apply')]) {
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /no branch checked out \(detached HEAD\): check out the branch you work on there/);
  }
});

test('a main checkout with a recorded lane checked out stops with the step back to its base', () => {
  const dir = makeRepo();
  git(dir, 'switch', '-q', '-c', 'develop');
  git(dir, 'switch', '-q', '-c', 'lane/a');
  git(dir, 'config', 'branch.lane/a.cs-lane-base', 'develop');
  const result = check(dir);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /has the lane lane\/a checked out \(claimed on develop\): switch it back to develop/);
});

test('prune --apply on feature/x keeps a develop marked as a base, and check does not list it', () => {
  const dir = featureFromDevelop();
  git(dir, 'config', 'branch.develop.cs-base', 'true');
  assert.ok(!lines(check(dir)).some((line) => line.includes(' develop ')), check(dir).stdout);
  const result = prune(dir, '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(branchExists(dir, 'develop'), result.stdout);
});

test('prune --apply on feature/x keeps the develop origin/HEAD points at', () => {
  const dir = featureFromDevelop();
  setOriginHead(dir, 'develop');
  const result = prune(dir, '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(branchExists(dir, 'develop'), result.stdout);
});

// findLeftovers never names a base branch; prune's own check is the last guard when a caller hands one in.
test('prune keeps a base branch handed in as a merged candidate and names why', () => {
  const dir = featureFromDevelop();
  git(dir, 'config', 'branch.develop.cs-base', 'true');
  setOriginHead(dir, 'develop');
  const repo = openRepo(dir, null);
  const develop = { name: 'develop', short: 'x', state: 'ancestor', tip: git(dir, 'rev-parse', 'develop') };
  const items = pruneRepo(repo, { apply: false, leftovers: { ...findLeftovers(repo), mergedBranches: [develop] } });
  const kept = items.find((entry) => entry.subject === 'develop');
  assert.equal(kept?.action, 'keep');
  assert.equal(kept.detail, 'it is a base branch here (marked as a base (git config branch.develop.cs-base))', 'the first why wins');
  git(dir, 'config', '--unset', 'branch.develop.cs-base');
  const byRemote = pruneRepo(openRepo(dir, null), { apply: false, leftovers: { ...findLeftovers(repo), mergedBranches: [develop] } });
  assert.equal(byRemote.find((entry) => entry.subject === 'develop')?.detail, 'it is a base branch here (origin/HEAD points at it)');
});

test('prune --apply on feature/x removes a merged develop that is neither marked nor a remote HEAD', () => {
  const dir = featureFromDevelop();
  assert.equal(prune(dir, '--apply').status, 0);
  assert.equal(branchExists(dir, 'develop'), false);
});

test('lane claim refuses a marked base branch as a lane', () => {
  const dir = featureFromDevelop();
  git(dir, 'config', 'branch.develop.cs-base', 'true');
  const base = git(dir, 'rev-parse', 'feature/x');
  const result = tidy(['lane', 'claim', '--repo', dir, '--branch', 'develop', '--base', base], { cwd: dir, env: laneEnv() });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /develop is a base branch of this repository, never a lane/);
});
