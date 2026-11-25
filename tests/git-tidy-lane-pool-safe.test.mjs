// Tests that a lane refill never empties a handed-out lane (piece pool-1, feature lane-pool-safe): a fill file that a killed or failed
// claim leaves behind is ignored on a lane that holds its branch, a checkout claim, release and land delete it, and a land
// whose slot has a held index.lock still leaves no worktree unlocked on its branch. The CLI runs on throw-away repos in the OS temp
// folder, every child with its own temp HOME, USERPROFILE and TMPDIR and a fake session id, so nothing reads or writes the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILL_ENV } from '../home/tools/git-tidy/lib/lane-fill.mjs';
import { CLEAN_ENV, commit, git, tidy } from './git-tidy-helpers.mjs';
import { deadPid, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const FAKE_SESSION_ID = 'pool-safe-test-0001';
const CHECKOUT_MODE = 'checkout';
const FILL_FOLDER = 'cs-lane-fill';
const WORK_TEXT = 'uncommitted work\n';
const EDITED_TEXT = 'edited by hand\n';
const TRACKED_FILE = 'base.txt'; // the file makeRepo commits
const UNTRACKED_FILE = 'work.txt';
const UNREADABLE_FOLDER_MODE = 0o555;
const OWNER_MODE = 0o755;
const CANNOT_BLOCK_WRITES = { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'chmod 555 does not stop writes on Windows or for root' };

/** An environment of one test: its own HOME, USERPROFILE and TMPDIR (nothing of the real ~/.claude) and a fake session id. */
function safeEnv(extra = {}) {
  const home = realpathSync(makeTempDir('pool-safe-home-'));
  const tmp = realpathSync(makeTempDir('pool-safe-tmp-'));
  return { HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: FAKE_SESSION_ID, ...extra };
}

const checkoutEnv = (env) => ({ ...env, [FILL_ENV]: CHECKOUT_MODE });
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const branchOf = (folder) => git(folder, 'branch', '--show-current');
const commonDirOf = (repo) => git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const fillFileOf = (repo, number) => join(commonDirOf(repo), FILL_FOLDER, `lane-${number}.json`);
const branchExists = (repo, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

/** `git-tidy lane claim ... --json`: the CLI result and, when it exited 0, its parsed JSON. */
function claim(repo, env, { branch, base, snapshot = false }) {
  const target = snapshot ? ['--snapshot'] : ['--branch', branch];
  const result = tidy(['lane', 'claim', '--repo', repo, ...target, '--base', base, '--json'], { env });
  return { result, claimed: result.status === 0 ? JSON.parse(result.stdout) : null };
}

/** A claim that must succeed; returns its parsed JSON. */
function claimOk(repo, env, lane) {
  const { result, claimed } = claim(repo, env, lane);
  assert.equal(result.status, 0, result.stderr);
  return claimed;
}

/** Plants the fill file a killed claim of `branch` leaves for slot `number`: the pid of a process that is gone. */
function plantDeadFill(repo, number, branch, target) {
  const fillFile = { pid: deadPid(), branch, target, startedAt: new Date().toISOString() };
  writeFile(fillFileOf(repo, number), JSON.stringify(fillFile));
}

/**
 * The state a clone claim of lane/a killed right after its end step's switch leaves: lane-1 on lane/a and locked `cs-lane-pool lane/a`
 * (the claim got that far), plus the fill file the claim had not deleted yet, naming a dead pid. Returns the repo, env, base and folder.
 */
function killedAfterSwitch() {
  const repo = jsRepo();
  const env = safeEnv();
  const base = head(repo);
  const claimed = claimOk(repo, env, { branch: 'lane/a', base });
  const folder = poolPath(repo, 1);
  assert.equal(claimed.folder, folder);
  plantDeadFill(repo, 1, 'lane/a', base);
  return { repo, env, base, folder };
}

test('a clone claim after a claim killed after its switch takes the next lane and keeps the first lane, its branch and its files', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = killedAfterSwitch();
  writeFile(join(folder, UNTRACKED_FILE), WORK_TEXT);
  writeFile(join(folder, TRACKED_FILE), EDITED_TEXT);

  const second = claimOk(repo, env, { branch: 'lane/b', base });

  assert.equal(second.folder, poolPath(repo, 2));
  assert.equal(readFileSync(join(folder, UNTRACKED_FILE), 'utf8'), WORK_TEXT, 'the untracked file is kept');
  assert.equal(readFileSync(join(folder, TRACKED_FILE), 'utf8'), EDITED_TEXT, 'the edited tracked file is kept');
  assert.equal(branchOf(folder), 'lane/a');
  assert.ok(branchExists(repo, 'lane/a'), 'the branch lane/a still exists');
});

test('a retry claim of the branch of a lane killed after its switch is refused, naming the lane that holds it', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = killedAfterSwitch();
  claimOk(repo, env, { branch: 'lane/b', base });

  const { result } = claim(repo, env, { branch: 'lane/a', base });

  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(result.stderr.includes(`branch lane/a is checked out in ${folder}`), result.stderr);
});

test('a checkout claim deletes the orphan fill file of its slot, and a later clone claim leaves that lane and its files alone', NEEDS_CLONE, () => {
  const repo = jsRepo();
  const env = safeEnv();
  const base = head(repo);
  plantDeadFill(repo, 1, 'lane/gone', base); // a claim killed before its worktree add left it: no lane-1 exists yet

  const first = claimOk(repo, checkoutEnv(env), { branch: 'lane/x', base });
  assert.equal(first.folder, poolPath(repo, 1));
  assert.equal(existsSync(fillFileOf(repo, 1)), false, 'the checkout claim deleted the fill file');
  writeFile(join(first.folder, UNTRACKED_FILE), WORK_TEXT);

  const second = claimOk(repo, env, { branch: 'lane/y', base });

  assert.equal(second.folder, poolPath(repo, 2));
  assert.equal(readFileSync(join(first.folder, UNTRACKED_FILE), 'utf8'), WORK_TEXT, 'the work in lane-1 is kept');
  assert.equal(branchOf(first.folder), 'lane/x');
});

test('a checkout snapshot claim after a clone snapshot claim that failed before its worktree add keeps its lane and files from the next clone claim', { skip: NEEDS_CLONE.skip || CANNOT_BLOCK_WRITES.skip }, () => {
  const repo = jsRepo();
  const env = safeEnv();
  const base = head(repo);
  const pool = join(realpathSync(repo), '.claude', 'worktrees');
  mkdirSync(pool, { recursive: true });
  chmodSync(pool, UNREADABLE_FOLDER_MODE);
  try {
    const failed = claim(repo, env, { snapshot: true, base });
    assert.notEqual(failed.result.status, 0, 'the clone claim fails: git cannot add a worktree in a read-only pool folder');
  } finally {
    chmodSync(pool, OWNER_MODE);
  }
  assert.equal(existsSync(poolPath(repo, 1)), false, 'the failed claim made no lane-1 folder');

  const snapshot = claimOk(repo, checkoutEnv(env), { snapshot: true, base });
  assert.equal(snapshot.folder, poolPath(repo, 1));
  writeFile(join(snapshot.folder, UNTRACKED_FILE), WORK_TEXT);

  const next = claimOk(repo, env, { branch: 'lane/z', base });

  assert.equal(next.folder, poolPath(repo, 2));
  assert.equal(readFileSync(join(snapshot.folder, UNTRACKED_FILE), 'utf8'), WORK_TEXT, 'the file in the snapshot lane is kept');
});

test('land of a lane killed after its switch deletes its fill file, so the next clone claim reuses the lane as free with no broken-slot note', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = killedAfterSwitch();
  commit(folder, 'lane.txt');

  const landed = spawnSync(process.execPath, [LAND, 'lane/a', '--repo', repo], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
  assert.equal(landed.status, 0, landed.stderr);
  assert.notEqual(head(repo), base, 'main took the lane commit');
  assert.equal(existsSync(fillFileOf(repo, 1)), false, 'land deleted the fill file');

  const next = claimOk(repo, env, { branch: 'lane/b', base: head(repo) });

  assert.equal(next.folder, folder, 'the landed lane is free and reused');
  assert.deepEqual(next.fill.warnings, [], 'no note that the slot was broken and emptied');
});

test('release deletes the fill file of its lane, so the next clone claim reuses the lane as free with no broken-slot note', NEEDS_CLONE, () => {
  const repo = jsRepo();
  const env = safeEnv();
  const base = head(repo);
  const first = claimOk(repo, env, { branch: 'lane/r', base });
  plantDeadFill(repo, 1, 'lane/r', base);

  const released = tidy(['lane', 'release', '--repo', repo, '--folder', first.folder], { env });
  assert.equal(released.status, 0, released.stderr);
  assert.equal(existsSync(fillFileOf(repo, 1)), false, 'release deleted the fill file');

  const next = claimOk(repo, env, { branch: 'lane/s', base });

  assert.equal(next.folder, first.folder, 'the released lane is reused');
  assert.deepEqual(next.fill.warnings, [], 'no note that the slot was broken and emptied');
});

test('land of a lane whose admin folder holds an index.lock exits 1, keeps the lane locked on its branch, and a second land after the lock is gone frees it', () => {
  const repo = jsRepo();
  const env = safeEnv();
  const base = git(repo, 'branch', '--show-current');
  const claimed = claimOk(repo, env, { branch: 'lane/h', base: head(repo) });
  const tip = commit(claimed.folder, 'lane.txt');
  const indexLock = join(git(claimed.folder, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  writeFileSync(indexLock, '');
  const runLand = () => spawnSync(process.execPath, [LAND, 'lane/h', '--repo', repo], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });

  const kept = runLand();

  assert.equal(kept.status, 1, kept.stdout + kept.stderr);
  const keptLine = new RegExp(
    `^land: lane/h landed on ${escapeRegExp(base)} at ${tip}; lane folder ${escapeRegExp(claimed.folder)} not freed: git switch failed: .+; ` +
      `deal with that, then free it with: node ~/\\.claude/tools/git-tidy/git-tidy\\.mjs lane release --repo ${escapeRegExp(realpathSync(repo))} --folder ${escapeRegExp(claimed.folder)}$`,
    'm',
  );
  assert.match(kept.stderr, keptLine);
  assert.equal(head(repo), tip, 'the landing stands: main took the lane tip');
  const blocks = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').map((block) => block.split('\n'));
  const laneBlock = blocks.find((block) => realpathSync(block[0].slice('worktree '.length)) === claimed.folder);
  assert.ok(laneBlock?.includes('branch refs/heads/lane/h'), 'lane-1 is still on lane/h');
  assert.ok(laneBlock?.includes('locked cs-lane-pool lane/h'), 'lane-1 is still locked by the pool');
  const unlockedOnLane = blocks.filter((block) => block.includes('branch refs/heads/lane/h') && !block.some((line) => line.startsWith('locked')));
  assert.deepEqual(unlockedOnLane, [], 'no worktree on lane/h is left unlocked');

  rmSync(indexLock);
  const freed = runLand();

  assert.equal(freed.status, 0, freed.stdout + freed.stderr);
  assert.ok(freed.stdout.includes(`lane folder ${claimed.folder} detached at ${tip} (kept for the next lane)`), freed.stdout);
  assert.ok(freed.stdout.includes('deleted branch lane/h'), freed.stdout);
  const listed = tidy(['lane', 'list', '--repo', repo], { env });
  assert.match(listed.stdout.split('\n')[0], /^lane-1 free /, listed.stdout);
});
