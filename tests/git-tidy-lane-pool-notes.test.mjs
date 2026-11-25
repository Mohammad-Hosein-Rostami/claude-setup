// Tests that notes a person leaves in a lane folder are never lost to a land or a refill (piece pool-1, feature lane-pool-safe, acceptance 6.2
// and 6.3): a land refuses a lane with an untracked file and changes nothing, and a lane that gets an untracked file after its land reads busy.
// The CLI runs on throw-away repos in the OS temp folder, every child with its own temp HOME, USERPROFILE and TMPDIR and a fake session id,
// so nothing reads or writes the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, tidy } from './git-tidy-helpers.mjs';
import { deadPid, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const FAKE_SESSION_ID = 'pool-notes-test-0001';
const FILL_FOLDER = 'cs-lane-fill';
const NOTES_FILE = 'notes.txt';
const NOTES_TEXT = 'my notes, not yet committed\nsecond line\n';
const LANE_FILE = 'lane.txt';
const LANE_BRANCH = 'lane/a';
const NEXT_BRANCH = 'lane/b';
const LANE_LOCK = `locked cs-lane-pool ${LANE_BRANCH}`;

/** An environment of one test: its own HOME, USERPROFILE and TMPDIR (nothing of the real ~/.claude) and a fake session id. */
function safeEnv() {
  const home = realpathSync(makeTempDir('pool-notes-home-'));
  const tmp = realpathSync(makeTempDir('pool-notes-tmp-'));
  return { HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: FAKE_SESSION_ID };
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const laneTip = (repo) => git(repo, 'rev-parse', `refs/heads/${LANE_BRANCH}`);
const fillFileOf = (repo, number) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), FILL_FOLDER, `lane-${number}.json`);

/** The `git worktree list --porcelain` block of the worktree at `folder`: its path, head, branch and lock reason lines. */
function worktreeBlock(repo, folder) {
  const blocks = git(repo, 'worktree', 'list', '--porcelain').split('\n\n');
  const own = blocks.filter((block) => realpathSync(block.split('\n')[0].replace(/^worktree /, '')) === folder);
  assert.equal(own.length, 1, `exactly one worktree entry for ${folder}`);
  return own[0];
}

/** A clone claim that must succeed; returns its parsed JSON. */
function claimOk(repo, env, branch, base) {
  const result = tidy(['lane', 'claim', '--repo', repo, '--branch', branch, '--base', base, '--json'], { env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** `land <branch> --repo <repo>` as the boss runs it. */
const land = (repo, env, branch) => spawnSync(process.execPath, [LAND, branch, '--repo', repo], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });

/**
 * The p6 state: lane-1 on lane/a (clone claim, locked `cs-lane-pool lane/a`) with the fill file a claim killed after its switch leaves
 * (a dead pid), and a commit in the lane. Returns the repo, env, main's base and the lane-1 folder.
 */
function laneWithLeftoverFill() {
  const repo = jsRepo();
  const env = safeEnv();
  const base = head(repo);
  const claimed = claimOk(repo, env, LANE_BRANCH, base);
  const folder = poolPath(repo, 1);
  assert.equal(claimed.folder, folder);
  const fillFile = { pid: deadPid(), branch: LANE_BRANCH, target: base, startedAt: new Date().toISOString() };
  writeFile(fillFileOf(repo, 1), JSON.stringify(fillFile));
  commit(folder, LANE_FILE);
  return { repo, env, base, folder };
}

test('a land of a lane with an untracked notes file exits 1 naming the file count, changes nothing, and the next clone claim takes the next lane', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = laneWithLeftoverFill();
  writeFile(join(folder, NOTES_FILE), NOTES_TEXT);
  const tipBefore = laneTip(repo);
  const blockBefore = worktreeBlock(repo, folder);
  assert.ok(blockBefore.split('\n').includes(LANE_LOCK), `the lane is locked before the land: ${blockBefore}`);

  const landed = land(repo, env, LANE_BRANCH);

  assert.equal(landed.status, 1, landed.stdout + landed.stderr);
  assert.equal(landed.stderr.trim(), `land: the worktree of ${LANE_BRANCH} (${folder}) has 1 changed or untracked file(s); commit or move them first`);
  assert.equal(head(repo), base, 'main did not move');
  assert.equal(laneTip(repo), tipBefore, 'the branch lane/a did not move');
  assert.equal(worktreeBlock(repo, folder), blockBefore, 'lane-1 is still on lane/a and still locked');

  const next = claimOk(repo, env, NEXT_BRANCH, head(repo));

  assert.equal(next.folder, poolPath(repo, 2), 'lane-1 is busy, so the claim takes lane-2');
  assert.equal(readFileSync(join(folder, NOTES_FILE), 'utf8'), NOTES_TEXT, 'the notes are byte-identical');
});

test('notes written in a lane after its clean land are kept: the lane reads busy and the next clone claim takes the next lane', NEEDS_CLONE, () => {
  const { repo, env, base, folder } = laneWithLeftoverFill();
  const landed = land(repo, env, LANE_BRANCH);
  assert.equal(landed.status, 0, landed.stderr);
  assert.notEqual(head(repo), base, 'main took the lane commit');
  writeFile(join(folder, NOTES_FILE), NOTES_TEXT);

  const next = claimOk(repo, env, NEXT_BRANCH, head(repo));

  assert.equal(next.folder, poolPath(repo, 2), 'lane-1 holds an untracked file, so the claim takes lane-2');
  assert.equal(readFileSync(join(folder, NOTES_FILE), 'utf8'), NOTES_TEXT, 'the notes are byte-identical');
});
