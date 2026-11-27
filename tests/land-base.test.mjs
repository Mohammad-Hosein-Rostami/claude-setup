// Tests of land and the lane record (home/tools/land/land.mjs; plan base-current-branch, piece base-3): a lane claimed on one base
// is refused while another branch is checked out, lands after a switch back or after the printed `git config` step moves it; a
// checked-out lane is never a base; a lane with no record lands as before; a land marks its base (`branch.<base>.cs-base`).
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs) and every child gets its own temp HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, snapshot } from './git-tidy-helpers.mjs';
import { lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'lane/a';
const POOL_IGNORE = '.claude/\n'; // the pool folders live in <repo>/.claude/worktrees; ignored, so the base checkout stays clean
// The step the refusal prints to move a lane to the checked-out base: `git config <key> <base>`.
const MOVE_STEP = /move the lane on purpose: git config (\S+) (\S+), then land again/;

/** Runs land.mjs with `args` from `repo`, with a fresh temp HOME (where the ledger goes). */
function land(repo, args) {
  const home = realpathSync(makeTempDir('land-base-home-'));
  return spawnSync(process.execPath, [LAND, ...args], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });
}

/** The value of git config `key` in `repo`, or null when it is not set. */
function configOf(repo, key) {
  const read = spawnSync('git', ['config', '--get', key], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV });
  return read.status === 0 ? read.stdout.trim() : null;
}

/**
 * A repo whose lane/a is claimed from the pool on main (so recorded on main) with one commit, and whose main checkout then
 * switched to `feat`, made from main with a commit of its own.
 */
function laneOfMainWhileOnFeat() {
  const repo = makeRepo();
  commit(repo, '.gitignore', POOL_IGNORE);
  const claimed = lane(['claim', '--repo', repo, '--branch', LANE], laneEnv());
  assert.equal(claimed.status, 0, claimed.stderr);
  commit(poolPath(repo, 1), 'lane.txt');
  git(repo, 'switch', '-q', '-c', 'feat');
  commit(repo, 'feat.txt');
  return repo;
}

test('a lane claimed on main is refused while feat is checked out, and lands once main is checked out again', () => {
  const repo = laneOfMainWhileOnFeat();
  const before = snapshot(repo);
  const refused = land(repo, [LANE, '--repo', repo]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(`${LANE} was claimed on main, but ${repo} has feat checked out; nothing changed`), refused.stderr);
  assert.ok(refused.stderr.includes(`git switch main in ${repo}`), refused.stderr);
  assert.equal(snapshot(repo), before, 'neither feat nor the lane moved');

  git(repo, 'switch', '-q', 'main');
  const landed = land(repo, [LANE, '--repo', repo]);
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /^landed lane\/a on main at [0-9a-f]{40} \(1 commit\(s\)\)$/m);
  assert.equal(configOf(repo, 'branch.main.cs-base'), 'true');
});

test('after the printed git config step a lane claimed on main lands on feat, which is then marked as a base', () => {
  const repo = laneOfMainWhileOnFeat();
  const featBefore = git(repo, 'rev-parse', 'feat');
  const refused = land(repo, [LANE, '--repo', repo]);
  assert.equal(refused.status, 1, refused.stdout);
  const step = MOVE_STEP.exec(refused.stderr);
  assert.ok(step, refused.stderr);
  assert.deepEqual(step.slice(1), [`branch.${LANE}.cs-lane-base`, 'feat']);
  git(repo, 'config', step[1], step[2]);

  const landed = land(repo, [LANE, '--repo', repo]);
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /^landed lane\/a on feat at [0-9a-f]{40} \(1 commit\(s\)\)$/m);
  assert.equal(git(repo, 'merge-base', featBefore, 'feat'), featBefore, 'feat only moved forward');
  assert.equal(configOf(repo, 'branch.feat.cs-base'), 'true');
});

test('a main checkout on a recorded lane is no base: land is refused before anything changes', () => {
  const repo = makeRepo();
  commit(addWorktree(repo, 'other', 'feat/x'), 'x.txt');
  git(repo, 'switch', '-q', '-c', 'lane/b');
  git(repo, 'config', 'branch.lane/b.cs-lane-base', 'main');
  const before = snapshot(repo);
  const refused = land(repo, ['feat/x', '--repo', repo]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(`${repo} has the lane lane/b checked out (claimed on main), not a base: switch it back (git switch main there)`), refused.stderr);
  assert.equal(snapshot(repo), before, 'nothing moved');
});

test('a lane made with git worktree add -b has no record and lands as before; the land marks main as a base', () => {
  const repo = makeRepo();
  commit(addWorktree(repo, 'plain', LANE), 'lane.txt');
  assert.equal(configOf(repo, `branch.${LANE}.cs-lane-base`), null);
  assert.equal(configOf(repo, 'branch.main.cs-base'), null, 'nothing marked main before the land');
  const landed = land(repo, [LANE, '--repo', repo]);
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /^landed lane\/a on main at [0-9a-f]{40} \(1 commit\(s\)\)$/m);
  assert.equal(configOf(repo, 'branch.main.cs-base'), 'true');
});
