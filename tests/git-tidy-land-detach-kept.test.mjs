// Tests of what `git-tidy land` says and leaves when it cannot free the landed pool folder (piece detach-1, feature land-detach):
// the pool lock stays held for the whole wait (the detach is skipped, the folder stays locked on its branch) and a held index.lock
// makes the switch fail (one `not freed` line that names the `lane release` step, and that step frees the folder). The CLI runs on
// throw-away repos in the OS temp folder, every child with its own temp HOME, USERPROFILE and TMPDIR and a fake session id.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { adminDir, claim, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PRINTED_TOOL = 'node ~/.claude/tools/git-tidy/git-tidy.mjs';
const LANE_BRANCH = 'lane/h';
const POOL_LOCK_FILE = 'cs-lane-pool.lock';
const LOCK_HOLDER_TOKEN = 'a'.repeat(32);
const LOCK_FILE_MODE = 0o600;
const HELD_LOCK_TEST_TIMEOUT_MS = 180_000; // the detach waits POOL_LOCK_WAIT_MS (60 s) for the holder before it gives up
const HOLDER_LIFETIME_MS = 300_000;

const head = (dir) => git(dir, 'rev-parse', 'HEAD');

/** A repo with lane/h claimed in lane-1 and one commit there (not yet landed): `{ repo, env, folder, tip }`. */
function claimedLaneWithCommit() {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  env.TMPDIR = makeTempDir('land-detach-tmp-');
  const claimed = claim(repo, LANE_BRANCH, base, env);
  assert.equal(claimed.status, 0, claimed.stderr);
  const folder = poolPath(repo, 1);
  return { repo, env, folder, tip: commit(folder, 'lane.txt') };
}

/** The `git worktree list --porcelain` block of `folder`, as lines. */
function worktreeBlock(repo, folder) {
  const block = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').find((entry) => entry.split('\n')[0] === `worktree ${folder}`);
  assert.notEqual(block, undefined, `${folder} is not a worktree of ${repo}`);
  return block.split('\n');
}

/** Plants the pool lock of `repo` as a live claim holds it: the pid of a process that stays until the test's after hook kills it. */
function plantHeldPoolLock(t, repo) {
  const holder = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${HOLDER_LIFETIME_MS})`], { stdio: 'ignore' });
  t.after(() => holder.kill());
  assert.equal(typeof holder.pid, 'number', 'the holder process started');
  const lockPath = join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), POOL_LOCK_FILE);
  writeFileSync(lockPath, `${holder.pid} ${LOCK_HOLDER_TOKEN} test`, { mode: LOCK_FILE_MODE });
}

test('land while a live process holds the pool lock lands, skips the detach and leaves the lane folder on its branch, locked', { timeout: HELD_LOCK_TEST_TIMEOUT_MS }, (t) => {
  const { repo, env, folder, tip } = claimedLaneWithCommit();
  plantHeldPoolLock(t, repo);

  const landed = tidy(['land', LANE_BRANCH, repo, '--tip', tip, '--json'], { env });

  assert.equal(head(repo), tip, 'main took the lane tip');
  const result = JSON.parse(landed.stdout);
  assert.equal(result.status, 'landed');
  const { why, ...detached } = result.detached;
  assert.deepEqual(detached, { folder: null, kept: null, other: null });
  assert.match(why, /lane pool lock .* is held/);
  const block = worktreeBlock(repo, folder);
  assert.ok(block.includes(`branch refs/heads/${LANE_BRANCH}`), block.join('\n'));
  assert.ok(block.includes(`locked cs-lane-pool ${LANE_BRANCH}`), block.join('\n'));
});

test('the text output of a land that skipped the detach has a `lane folder detach skipped: ` line', { timeout: HELD_LOCK_TEST_TIMEOUT_MS }, (t) => {
  const { repo, env, tip } = claimedLaneWithCommit();
  plantHeldPoolLock(t, repo);

  const landed = tidy(['land', LANE_BRANCH, repo, '--tip', tip], { env });

  assert.equal(head(repo), tip, 'main took the lane tip');
  const skipped = lines(landed).filter((line) => line.startsWith('lane folder detach skipped: '));
  assert.equal(skipped.length, 1, landed.stdout + landed.stderr);
  assert.match(skipped[0], /lane pool lock .* is held/);
});

test('land with an index.lock in the lane admin folder prints one `not freed` line naming the release step, and that step frees the folder', (t) => {
  const { repo, env, folder, tip } = claimedLaneWithCommit();
  const indexLock = join(adminDir(folder), 'index.lock');
  writeFileSync(indexLock, '');
  t.after(() => rmSync(indexLock, { force: true }));

  const landed = tidy(['land', LANE_BRANCH, repo, '--tip', tip], { env });

  assert.equal(head(repo), tip, 'main took the lane tip');
  const notFreed = lines(landed).filter((line) => line.startsWith('lane folder '));
  assert.equal(notFreed.length, 1, landed.stdout + landed.stderr);
  const [printed] = notFreed;
  assert.ok(printed.startsWith(`lane folder ${folder} not freed: git switch failed: `), printed);
  assert.ok(printed.endsWith(`lane release --repo ${repo} --folder ${folder}`), printed);
  const block = worktreeBlock(repo, folder);
  assert.ok(block.includes(`branch refs/heads/${LANE_BRANCH}`), 'the folder is still on its branch');
  assert.ok(block.includes(`locked cs-lane-pool ${LANE_BRANCH}`), 'the folder is still locked');

  rmSync(indexLock);
  const [, command] = printed.split('free it with: ');
  assert.ok(command?.startsWith(PRINTED_TOOL), `the printed step is a git-tidy command: ${printed}`);
  const [, repoArg, folderArg] = command.match(/ lane release --repo (\S+) --folder (\S+)$/);
  const released = tidy(['lane', 'release', '--repo', repoArg, '--folder', folderArg], { env });
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const listed = lines(tidy(['lane', 'list', '--repo', repo], { env }));
  assert.match(listed[0], /^lane-1 free /, listed.join('\n'));
});
