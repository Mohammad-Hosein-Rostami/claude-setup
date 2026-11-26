// Tests that land keeps a commit whose patch id pairs with a base commit while its change differs (tess-review R2): patch ids
// leave out line numbers, so the same line added at another place in the file pairs with a landed commit. A plain `git rebase`
// drops such a commit as "already upstream" and land then deletes the branch, so its change is lost. land.mjs (with and without
// --test) and `git-tidy land` rebase with `--reapply-cherry-picks`; a true duplicate still drops, since it becomes empty.
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs); each land run gets its own temp HOME, so
// the ledger goes to <HOME>/.claude/state/land/ there.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { claim, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { landLane } from '../home/tools/git-tidy/lib/land.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { readLandEntries } from '../home/tools/land/ledger.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'lane/l';
const TEST = 'test/t';
const SHARED = 'shared.txt';
const ADDED = 'NEW';
const PASS = 'exit 0'; // a test command both sh and cmd run as typed
const POOL_IGNORE = '.claude/\n'; // the pool folders live in <repo>/.claude/worktrees, so the base checkout stays clean

/** Runs land.mjs with `args` from `repo`, with `home` as HOME and USERPROFILE (where the ledger goes). */
const landWith = (home, repo, args) =>
  spawnSync(process.execPath, [LAND, ...args, '--repo', repo], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });

const makeHome = () => realpathSync(makeTempDir('land-reapply-home-'));
const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;
/** How many lines of main's shared.txt are the added line. */
const addedOnMain = (repo) => git(repo, 'show', `main:${SHARED}`).split('\n').filter((line) => line === ADDED).length;

/**
 * R2's setup: `TEST` adds ADDED at the first of two places with the same context, `LANE` at the second, so both commits have
 * one patch id; `LANE` has landed. `TEST` is in a plain worktree, or with `pool` in a folder claimed from the lane pool.
 * Returns `{ repo, home }`, `home` the HOME land runs with.
 */
function r2WithLaneLanded({ pool = false } = {}) {
  const repo = makeRepo();
  const twice = `${['a', 'b', 'c', 'd', 'e', 'f'].join('\n')}\n`; // the same lines twice, so both places have one context
  if (pool) commit(repo, '.gitignore', POOL_IGNORE);
  commit(repo, SHARED, `${twice}g\nh\n${twice}`);
  const env = pool ? laneEnv() : { HOME: makeHome() };
  if (pool) assert.equal(claim(repo, TEST, git(repo, 'rev-parse', 'HEAD'), env).status, 0);
  const testTree = pool ? poolPath(repo, 1) : addWorktree(repo, 'test', TEST);
  const testTip = commit(testTree, SHARED, `a\nb\nc\n${ADDED}\nd\ne\nf\ng\nh\n${twice}`);
  const laneTree = addWorktree(repo, 'lane', LANE);
  const laneTip = commit(laneTree, SHARED, `${twice}g\nh\na\nb\nc\n${ADDED}\nd\ne\nf\n`);
  assert.equal(patchIdOf(repo, testTip), patchIdOf(repo, laneTip), 'precondition: the two commits have one patch id');
  const landed = landWith(env.HOME, repo, [LANE]);
  assert.equal(landed.status, 0, landed.stderr);
  return { repo, home: env.HOME };
}

/** The verbatim patch id of commit `sha`, as git computes it from `git show` (tests/land-sweep.test.mjs R2). */
function patchIdOf(repo, sha) {
  const shown = git(repo, 'show', '--format=', sha);
  const result = spawnSync('git', ['patch-id', '--verbatim'], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV, input: `${shown}\n` });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(' ')[0];
}

/** The last ledger line of `repo` under `home`. */
const lastLanding = (repo, home) => readLandEntries(repo, { HOME: home }).entries.at(-1);

test('R2: land keeps a test branch whose patch id pairs with the landed lane, and lands its change', () => {
  const { repo, home } = r2WithLaneLanded();
  const result = landWith(home, repo, [TEST]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(addedOnMain(repo), 2, 'both changes are on main');
  assert.equal(lastLanding(repo, home).branch, TEST);
  assert.equal(lastLanding(repo, home).commits, 1);
});

test('R2: land --test keeps the pairing commit of a pool lane, and lands its change', () => {
  const { repo, home } = r2WithLaneLanded({ pool: true });
  const result = landWith(home, repo, [TEST, '--test', PASS]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(addedOnMain(repo), 2, 'both changes are on main');
  assert.equal(lastLanding(repo, home).branch, TEST);
  assert.equal(lastLanding(repo, home).commits, 1);
});

test('R2: git-tidy land keeps the pairing commit, and lands its change', () => {
  const { repo } = r2WithLaneLanded();
  const result = landLane(openRepo(repo, null), TEST, {});
  assert.equal(result.status, 'landed');
  assert.equal(addedOnMain(repo), 2, 'both changes are on main');
});

test('a true duplicate (a plain cherry-pick of a landed commit) still drops: main does not move and the branch is deleted', () => {
  const repo = makeRepo();
  const home = makeHome();
  const forkPoint = git(repo, 'rev-parse', 'HEAD');
  const laneTree = addWorktree(repo, 'lane', LANE);
  commit(laneTree, 'feature.txt', 'feature\n');
  assert.equal(landWith(home, repo, [LANE]).status, 0);
  const landedTip = git(repo, 'rev-parse', 'main');
  git(repo, 'switch', '-q', '-c', 'dup', forkPoint);
  git(repo, 'cherry-pick', landedTip);
  git(repo, 'switch', '-q', 'main');
  const result = landWith(home, repo, ['dup']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), landedTip, 'main did not move');
  assert.equal(branchExists(repo, 'dup'), false, 'dup is deleted');
});
