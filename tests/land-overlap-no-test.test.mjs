// Tests for land with no --test when the base and the lane changed the same file (home/tools/land/land.mjs, ef222fdd; guard-removal plan A13):
// land rebases and lands whatever both sides changed and runs no test of its own; --test still tests the rebased tip and a failing one
// leaves the base unmoved; a dirty lane worktree is still refused. Before ef222fdd an overlap with no --test was refused (exit 1).
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs), and land runs with its own temp HOME, USERPROFILE and TMPDIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, git, makeRepo, snapshot } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'feat/lane';
const SHARED = 'shared.txt';
const BASE_LINES = ['one', 'two', 'three', 'four', 'five'];
// The lane edits the first line and the base the last, so the rebase merges both without a textual conflict.
const LANE_LINES = ['lane one', ...BASE_LINES.slice(1)];
const MOVED_BASE_LINES = [...BASE_LINES.slice(0, -1), 'base five'];
const MERGED_LINES = ['lane one', ...BASE_LINES.slice(1, -1), 'base five'];
// Commands both sh and cmd run as typed.
const PASS = 'exit 0';
const FAIL = 'exit 1';

const text = (lines) => lines.map((line) => `${line}\n`).join('');
const outputLines = (output) => output.split(/\r?\n/).filter((line) => line !== '');
const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

/** Runs land from `repo` with a private HOME, USERPROFILE and TMPDIR (the land ledger goes to that HOME). */
function land(repo, ...args) {
  const home = makeTempDir('land-overlap-home-');
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home, TMPDIR: home };
  return spawnSync(process.execPath, [LAND, LANE, '--repo', repo, ...args], { cwd: repo, encoding: 'utf8', env });
}

/** Commits `lines` as SHARED in `dir`; returns the full hash. */
function commitShared(dir, lines, message) {
  writeFileSync(join(dir, SHARED), text(lines));
  git(dir, 'add', '--', SHARED);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A repo where the base and the lane (own worktree) both changed SHARED since the lane branched: the lane edits line 1, then the base line 5. */
function overlapRepo() {
  const repo = makeRepo();
  commitShared(repo, BASE_LINES, 'add the shared file');
  const worktree = addWorktree(repo, 'lane', LANE);
  commitShared(worktree, LANE_LINES, 'lane edits line 1');
  commitShared(repo, MOVED_BASE_LINES, 'base edits line 5');
  return { repo, worktree };
}

/** Everything a refused land must leave alone: the refs, the worktree list and the status of the base and the lane folders. */
const state = (repo, worktree) => snapshot(repo, worktree);

test('two lanes that changed the same file land with no --test: exit 0, both edits on main in a straight line, no test run', () => {
  const { repo, worktree } = overlapRepo();
  const result = land(repo);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout), [
    `landed ${LANE} on main at ${tip} (1 commit(s))`,
    `removed worktree ${worktree}`,
    `deleted branch ${LANE}`,
    'left: none',
  ]);
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MERGED_LINES), 'the lane edit and the base edit are both in the landed file');
  assert.equal(git(repo, 'log', '--merges', '--oneline', 'main'), '', 'no merge commit');
  assert.equal(git(repo, 'rev-list', '--count', 'main'), '4', 'base, shared file, base edit and the rebased lane edit on one line');
  assert.equal(existsSync(worktree), false);
  assert.equal(branchExists(repo, LANE), false);
});

test('a passing --test on overlapping lanes still tests the rebased tip, then lands it', () => {
  const { repo } = overlapRepo();
  const result = land(repo, '--test', PASS);
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.ok(outputLines(result.stdout).includes(`test passed on ${tip}`), result.stdout);
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MERGED_LINES));
});

test('a failing --test on overlapping lanes is refused with exit 1: main is unmoved and the lane is as it was', () => {
  const { repo, worktree } = overlapRepo();
  const before = state(repo, worktree);
  const mainBefore = git(repo, 'rev-parse', 'main');
  const laneBefore = git(repo, 'rev-parse', LANE);
  const result = land(repo, '--test', FAIL);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`^land: the test of [0-9a-f]{40} failed .*: ${FAIL}\\. Nothing landed: main did not move and ${LANE} is as it was`), result.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore, 'main did not move');
  assert.equal(git(repo, 'rev-parse', LANE), laneBefore, 'the lane branch did not move');
  assert.equal(state(repo, worktree), before, 'refs, worktrees and their status are as they were');
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MOVED_BASE_LINES), 'the base file has no lane edit');
});

test('a lane worktree with an untracked file is refused with exit 1: nothing moves', () => {
  const { repo, worktree } = overlapRepo();
  writeFileSync(join(worktree, 'notes.txt'), 'unsaved work');
  const before = state(repo, worktree);
  const result = land(repo);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: the worktree of ${LANE} (${worktree}) has 1 changed or untracked file(s); commit or move them first`), result.stderr);
  assert.equal(state(repo, worktree), before);
  assert.equal(readFileSync(join(worktree, 'notes.txt'), 'utf8'), 'unsaved work', 'the unsaved file is still there');
});

test('a lane worktree with an edited tracked file is refused with exit 1: nothing moves', () => {
  const { repo, worktree } = overlapRepo();
  writeFileSync(join(worktree, SHARED), text([...LANE_LINES, 'unsaved edit']));
  const before = state(repo, worktree);
  const result = land(repo);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: the worktree of ${LANE} (${worktree}) has 1 changed or untracked file(s)`), result.stderr);
  assert.equal(state(repo, worktree), before);
});
