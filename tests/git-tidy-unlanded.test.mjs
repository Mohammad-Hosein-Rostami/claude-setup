// Tests for two `git-tidy check` items about work left lying around: the hint `unlanded-lane?` (a branch with commits the base lacks
// and no new commit for over 2 hours) and the finding `dirty-base` (the folder where the base is checked out has uncommitted changes
// to tracked files). Each test builds its own repo in a temp folder (git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, CLEAN_ENV, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const check = (dir) => tidy(['check', dir], { cwd: dir });
const linesOf = (result, kind) => lines(result).filter((line) => line.startsWith(`${kind} `));
const THREE_HOURS_AGO = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

/** Commits `file` in `dir` with the committer date set to `date`. */
function commitAt(dir, file, date) {
  writeFileSync(join(dir, file), file);
  git(dir, 'add', '--', file);
  const result = spawnSync('git', ['commit', '-q', '-m', `add ${file}`], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  assert.equal(result.status, 0, result.stderr);
}

test('a lane with a commit the base lacks and no commit for 3 hours is the hint unlanded-lane?; it alone does not fail the check', () => {
  const dir = makeRepo();
  const lane = addWorktree(dir, 'wt-old', 'old-lane');
  commitAt(lane, 'old.txt', THREE_HOURS_AGO());
  const result = check(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(linesOf(result, 'unlanded-lane?'), ['unlanded-lane? old-lane ahead 1, no commit for 3 h: land it (rebase, merge --ff-only) or say why it waits']);
});

test('a lane committed to just now, a merged branch and a branch with no work are not unlanded-lane?', () => {
  const dir = makeRepo();
  commit(addWorktree(dir, 'wt-new', 'new-lane'), 'new.txt');
  git(dir, 'branch', 'empty');
  assert.deepEqual(linesOf(check(dir), 'unlanded-lane?'), []);
});

test('the base folder with a changed tracked file is the finding dirty-base; untracked or ignored files there are not', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'notes.txt'), 'untracked');
  assert.deepEqual(linesOf(check(dir), 'dirty-base'), []);
  writeFileSync(join(dir, 'base.txt'), 'edited in the base folder');
  const result = check(dir);
  assert.equal(result.status, 1);
  assert.deepEqual(linesOf(result, 'dirty-base'), [`dirty-base ${dir} 1 changed tracked files: commit them in a lane worktree, the base folder holds no edits`]);
});

test('a dirty lane worktree is not dirty-base, and a base checked out in a linked worktree is found there', () => {
  const dir = makeRepo();
  git(dir, 'switch', '-q', '-c', 'side');
  const lane = addWorktree(dir, 'wt-side-lane', 'lane');
  writeFileSync(join(lane, 'base.txt'), 'lane edit');
  writeFileSync(join(dir, 'base.txt'), 'edit on side');
  assert.deepEqual(linesOf(check(dir), 'dirty-base'), []);
  const baseTree = addWorktree(dir, 'wt-base', 'main', { create: false });
  writeFileSync(join(baseTree, 'base.txt'), 'edit on main');
  assert.deepEqual(linesOf(check(dir), 'dirty-base').map((line) => line.split(' ')[1]), [baseTree]);
});
