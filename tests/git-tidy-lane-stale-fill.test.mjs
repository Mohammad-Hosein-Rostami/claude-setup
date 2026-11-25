// Tests that a dead fill file never makes a lane with work in it a broken slot (home/tools/git-tidy/lib/lane-slots.mjs fillStateOf,
// workAfterFillWhy): a stopped fill locks `cs-lane-pool <its label>` and moves HEAD only to its target, so a rebase stopped there, a lock
// that is not the fill's, or a HEAD off the base that is not the target means work after the fill, and the slot stays busy. Without such a
// sign the slot stays broken and the next clone claim refills it. The CLI runs on throw-away repos in the OS temp folder, every child with
// its own temp HOME, USERPROFILE and TMPDIR and a fake session id, so nothing reads or writes the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILL_ENV } from '../home/tools/git-tidy/lib/lane-fill.mjs';
import { CLEAN_ENV, commit, git, lines, tidy } from './git-tidy-helpers.mjs';
import { NEEDS_CLONE, filesOf, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { adminDir, deadPid, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const FILL_FOLDER = 'cs-lane-fill';
const CHECKOUT_MODE = 'checkout';
const CONFLICT_FILE = 'clash.txt';
const WORK_FILE = 'work.txt';
const WORK_TEXT = 'uncommitted work\n';
const LANE_SIDE = 'the lane side\n';
const MAIN_SIDE = 'the main side\n';

/** An environment of one test: lane-pool-helpers' laneEnv (own HOME, a session id) plus its own TMPDIR. */
function privateEnv() {
  return { ...laneEnv(), TMPDIR: realpathSync(makeTempDir('stale-fill-tmp-')) };
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const branchOf = (folder) => git(folder, 'branch', '--show-current');
const commonDirOf = (repo) => git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const fillFileOf = (repo, number) => join(commonDirOf(repo), FILL_FOLDER, `lane-${number}.json`);

/** `git-tidy lane <args>` in `repo`; a claim that must succeed returns its stdout lines and stderr. */
function claimOk(repo, env, args) {
  const result = tidy(['lane', 'claim', '--repo', repo, ...args], { env });
  assert.equal(result.status, 0, result.stderr);
  return { lines: lines(result), stderr: result.stderr };
}

const claimBranch = (repo, env, branch, base) => claimOk(repo, env, ['--branch', branch, '--base', base]);

/** The `lane list` line of lane-`number`. */
function listLine(repo, env, number) {
  const result = tidy(['lane', 'list', '--repo', repo], { env });
  assert.equal(result.status, 0, result.stderr);
  return lines(result).find((line) => line.startsWith(`lane-${number} `)) ?? '';
}

/** Plants the fill file a killed clone claim of `branch` leaves for slot `number`: the pid of a process that is gone. */
function plantDeadFill(repo, number, branch, target) {
  writeFile(fillFileOf(repo, number), JSON.stringify({ pid: deadPid(), branch, target, startedAt: new Date().toISOString() }));
}

/**
 * A repo with lane-1 handed out by a checkout claim (locked `cs-lane-pool lane/a`), as the state a clone claim leaves when it is killed
 * right after its lock; the caller then shapes lane-1's HEAD and plants the fill file.
 */
function repoWithLaneA() {
  const repo = jsRepo();
  const env = privateEnv();
  const base = head(repo);
  claimBranch(repo, { ...env, [FILL_ENV]: CHECKOUT_MODE }, 'lane/a', base);
  return { repo, env, base, folder: poolPath(repo, 1) };
}

/** lane-1 with `lane/a` and `main` holding conflicting `clash.txt`, rebased so that it stops on the conflict (HEAD detached by the rebase). */
function stopRebaseOnConflict(repo, folder) {
  commit(folder, CONFLICT_FILE, LANE_SIDE);
  commit(repo, CONFLICT_FILE, MAIN_SIDE);
  const rebase = spawnSync('git', ['rebase', 'main'], { cwd: folder, encoding: 'utf8', env: CLEAN_ENV });
  assert.notEqual(rebase.status, 0, 'precondition: the rebase stops on the conflict');
}

const rebaseStopped = (folder) => existsSync(join(adminDir(folder), 'rebase-merge')) || existsSync(join(adminDir(folder), 'rebase-apply'));

test('a dead fill file on a lane whose rebase stopped on a conflict reads busy, not broken', () => {
  const { repo, env, base, folder } = repoWithLaneA();
  stopRebaseOnConflict(repo, folder);
  plantDeadFill(repo, 1, 'lane/a', base);

  assert.match(listLine(repo, env, 1), /^lane-1 busy the fill of lane\/a by pid \d+ stopped, but a rebase is not finished there$/);
});

test('a clone claim after a dead fill file on a lane with a stopped rebase takes the next lane and leaves the rebase and its files as they are', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = repoWithLaneA();
  stopRebaseOnConflict(repo, folder);
  plantDeadFill(repo, 1, 'lane/a', base);
  const filesBefore = filesOf(folder);
  const statusBefore = git(folder, 'status', '--porcelain');

  const second = claimBranch(repo, env, 'lane/b', base);

  assert.equal(second.lines[0], `lane: ${poolPath(repo, 2)}`);
  assert.ok(rebaseStopped(folder), 'the rebase is still stopped in lane-1');
  assert.deepEqual(filesOf(folder), filesBefore, 'lane-1 holds the same files, conflict markers included');
  assert.equal(git(folder, 'status', '--porcelain'), statusBefore);
  assert.match(readFileSync(join(folder, CONFLICT_FILE), 'utf8'), /^<{7} /m, 'the conflict markers are still there');
});

test('a dead fill file for lane/x on a snapshot lane reads busy, naming the lock that is not that fill\'s', () => {
  const repo = jsRepo();
  const env = privateEnv();
  claimOk(repo, { ...env, [FILL_ENV]: CHECKOUT_MODE }, ['--snapshot', '--base', head(repo)]);
  plantDeadFill(repo, 1, 'lane/x', head(repo));

  assert.match(listLine(repo, env, 1), /^lane-1 busy the fill of lane\/x by pid \d+ stopped, but it is locked "cs-lane-pool snapshot [0-9a-f]{8}", not by that fill$/);
});

test('a clone claim after a dead fill file for lane/x on a snapshot lane takes the next lane and keeps the snapshot lane and its files', NEEDS_CLONE, () => {
  const repo = jsRepo();
  const env = privateEnv();
  const base = head(repo);
  claimOk(repo, { ...env, [FILL_ENV]: CHECKOUT_MODE }, ['--snapshot', '--base', base]);
  const folder = poolPath(repo, 1);
  writeFile(join(folder, WORK_FILE), WORK_TEXT);
  plantDeadFill(repo, 1, 'lane/x', base);

  const next = claimBranch(repo, env, 'lane/b', base);

  assert.equal(next.lines[0], `lane: ${poolPath(repo, 2)}`);
  assert.equal(readFileSync(join(folder, WORK_FILE), 'utf8'), WORK_TEXT, 'the work in the snapshot lane is kept');
  assert.match(listLine(repo, env, 1), /^lane-1 busy the fill of lane\/x by pid \d+ stopped, but it is locked /, 'lane-1 stays busy after the claim');
});

/** lane-1 on a commit of its own, detached (the branch lane/a deleted, so only HEAD holds the commit), with a matching dead fill file for the base. */
function detachedOnOwnCommit() {
  const { repo, env, base, folder } = repoWithLaneA();
  const own = commit(folder, WORK_FILE, WORK_TEXT);
  git(folder, 'switch', '--quiet', '--detach');
  git(repo, 'branch', '-D', 'lane/a');
  plantDeadFill(repo, 1, 'lane/a', base);
  return { repo, env, base, folder, own };
}

test('a dead fill file on a lane detached at a commit that is off main and not the fill\'s target reads busy, naming that commit', () => {
  const { repo, env, folder, own } = detachedOnOwnCommit();

  assert.match(listLine(repo, env, 1), new RegExp(`^lane-1 busy the fill of lane/a by pid \\d+ stopped, but HEAD ${own.slice(0, 8)} has commits that are not on main$`));
  assert.equal(head(folder), own);
});

test('a clone claim after a dead fill file on a lane detached at its own commit takes the next lane and leaves that commit as the HEAD with its file', NEEDS_CLONE, () => {
  const { repo, env, base, folder, own } = detachedOnOwnCommit();

  const next = claimBranch(repo, env, 'lane/b', base);

  assert.equal(next.lines[0], `lane: ${poolPath(repo, 2)}`);
  assert.equal(head(folder), own, 'lane-1 is still at its own commit');
  assert.equal(readFileSync(join(folder, WORK_FILE), 'utf8'), WORK_TEXT);
  assert.equal(git(repo, 'cat-file', '-t', own), 'commit');
});

/** lane-1 detached at the base, which is the fill's target, locked for that fill, clean, with a dead fill file: what a killed fill leaves. */
function killedFillAtTarget() {
  const { repo, env, base, folder } = repoWithLaneA();
  git(folder, 'switch', '--quiet', '--detach');
  plantDeadFill(repo, 1, 'lane/a', base);
  return { repo, env, base, folder };
}

// Regression guard: tests/git-tidy-lane-claim-fill.test.mjs already shows a killed fill refilled; this one keeps the same input
// (matching lock, HEAD at the target, nothing else there) next to the three that now stay busy. It passes on the code before the fix too.
test('a dead fill file on a clean lane detached at the fill\'s target with the fill\'s lock reads broken', () => {
  const { repo, env } = killedFillAtTarget();

  assert.match(listLine(repo, env, 1), /^lane-1 broken the fill of lane\/a by pid \d+ stopped$/);
});

test('a clone claim after a dead fill file on a clean lane at the fill\'s target takes that lane again and fills it', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = killedFillAtTarget();

  const next = claimBranch(repo, env, 'lane/b', base);

  assert.equal(next.lines[0], `lane: ${folder}`);
  assert.match(next.stderr, /lane-1 was broken .* emptied and filled again/);
  assert.equal(branchOf(folder), 'lane/b');
  assert.equal(existsSync(fillFileOf(repo, 1)), false, 'the end step deleted the fill file');
});
