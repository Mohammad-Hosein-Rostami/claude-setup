// Tests for `git-tidy check` on a tess-write folder: `git worktree add --lock -b test/<topic> <main>-wt/test-<topic> <main sha>` makes a
// locked lane with no commit of its own, which check reports as the info line `not started`, never as a merged leftover.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const BRANCH = 'test/x';
const CLEAN_SUMMARY = 'git-tidy: 0 findings, 0 hints (base main), all local refs on one line: yes';
const check = (dir, ...extra) => tidy(['check', dir, ...extra], { cwd: dir });
const checkJson = (dir) => JSON.parse(check(dir, '--json').stdout);
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

/** The folder tess makes for a test lane, locked, at the sha of main; returns the repo and the real folder path. */
function lockedTestLane() {
  const dir = makeRepo();
  const folder = join(`${dir}-wt`, 'test-x');
  git(dir, 'worktree', 'add', '-q', '--lock', '-b', BRANCH, folder, git(dir, 'rev-parse', 'main'));
  return { dir, folder: realpathSync(folder) };
}

test('a locked test lane with no commit of its own is a not-started info line, not a merged leftover, and the check exits 0', () => {
  const { dir, folder } = lockedTestLane();
  const result = check(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result), [
    'base: main (checked out)',
    `not started: ${BRANCH} in ${folder} (locked, no commit of its own yet)`,
    CLEAN_SUMMARY,
  ]);
});

test('the json of a locked test lane carries a not-started-lane info item and no finding or hint', () => {
  const { dir, folder } = lockedTestLane();
  const report = checkJson(dir);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.hints, []);
  assert.deepEqual(report.info, [
    { kind: 'not-started-lane', subject: BRANCH, detail: `in ${folder} (locked, no commit of its own yet)` },
  ]);
});

test('the same test lane without --lock is a merged-branch and a merged-worktree finding and no not-started line', () => {
  const dir = makeRepo();
  const folder = join(`${dir}-wt`, 'test-x');
  git(dir, 'worktree', 'add', '-q', '-b', BRANCH, folder, git(dir, 'rev-parse', 'main'));
  const result = check(dir);
  assert.equal(result.status, 1);
  const report = checkJson(dir);
  assert.deepEqual(report.findings.map(({ kind, subject }) => [kind, subject]), [
    ['merged-branch', BRANCH],
    ['merged-worktree', realpathSync(folder)],
  ]);
  assert.equal(report.info, undefined);
  assert.ok(!lines(result).some((line) => line.startsWith('not started:')), result.stdout);
});

test('after one commit in the locked test lane there is no not-started line and no merged finding', () => {
  const { dir, folder } = lockedTestLane();
  commit(folder, 'work.txt');
  const result = check(dir);
  assert.ok(!lines(result).some((line) => line.startsWith('not started:')), result.stdout);
  const report = checkJson(dir);
  assert.equal(report.info, undefined);
  assert.deepEqual(report.findings, []);
});

test('unlocking and removing the clean test lane folder deletes the folder and keeps the branch', () => {
  const { dir, folder } = lockedTestLane();
  git(dir, 'worktree', 'unlock', folder);
  git(dir, 'worktree', 'remove', folder);
  assert.ok(!existsSync(folder));
  assert.ok(branches(dir).includes(BRANCH));
});
