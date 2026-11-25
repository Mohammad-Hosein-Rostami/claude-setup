// Tests of `git-tidy lane claim --snapshot` (lib/lane-pool.mjs, lane-cli.mjs): a lane with no branch, detached at an older commit of the main
// checkout, listed as `snapshot <8>` until `lane release` frees it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { claim, lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE } from './git-tidy-lane-fill-helpers.mjs';

const SHORT_SHA = 8;
const OLD_TEXT = 'version one\n';
const NEW_TEXT = 'version two\n';
const listOf = (repo, env) => lines(lane(['list', '--repo', repo], env));
const snapshotClaim = (repo, base, env, ...more) => lane(['claim', '--repo', repo, '--snapshot', '--base', base, ...more], env);

/** A repo whose main moved on: `older` has x.txt (version one); the tip also has y.txt and x.txt at version two. */
function repoThatMovedOn() {
  const repo = makeRepo();
  const older = commit(repo, 'x.txt', OLD_TEXT);
  commit(repo, 'x.txt', NEW_TEXT);
  commit(repo, 'y.txt', 'added later\n');
  return { repo, older, tip: git(repo, 'rev-parse', 'HEAD') };
}

test('a snapshot claim is detached at the older commit with no branch, its files equal that commit, and list names it snapshot <8>', () => {
  const { repo, older, tip } = repoThatMovedOn();
  const env = laneEnv();
  const branchesBefore = git(repo, 'for-each-ref', '--format=%(refname)');
  const result = snapshotClaim(repo, older, env);
  assert.equal(result.status, 0, result.stderr);
  const folder = poolPath(repo, 1);
  assert.equal(lines(result)[0], `lane: ${folder}`);
  assert.equal(lines(result).at(-1), 'snapshot: true');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), older);
  assert.notEqual(older, tip);
  assert.equal(git(folder, 'branch', '--show-current'), '', 'detached: no branch is checked out');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)'), branchesBefore, 'no branch was made');
  assert.equal(readFileSync(join(folder, 'x.txt'), 'utf8'), OLD_TEXT);
  assert.ok(!existsSync(join(folder, 'y.txt')), 'a file added after the snapshot commit is not there');
  assert.equal(git(folder, 'status', '--porcelain'), '');
  assert.equal(git(folder, 'diff', '--name-only', older), '');
  assert.deepEqual(listOf(repo, env), [`lane-1 busy snapshot ${older.slice(0, SHORT_SHA)}`]);
});

test('a snapshot filled by cloning a main checkout that is newer repairs the one file that differs', NEEDS_CLONE, () => {
  const { repo, older } = repoThatMovedOn();
  const result = snapshotClaim(repo, older, laneEnv(), '--json');
  assert.equal(result.status, 0, result.stderr);
  const { fill, snapshot } = JSON.parse(result.stdout);
  assert.equal(snapshot, true);
  assert.equal(fill.mode, 'clone');
  assert.equal(fill.repaired, 1, 'x.txt differs from the snapshot commit; y.txt is untracked there and was cleaned');
});

test('lane release frees a snapshot: the folder is free again, unlocked and still detached at that commit', () => {
  const { repo, older } = repoThatMovedOn();
  const env = laneEnv();
  assert.equal(snapshotClaim(repo, older, env).status, 0);
  const folder = poolPath(repo, 1);
  const released = lane(['release', '--repo', repo, '--folder', folder], env);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.match(lines(released)[0], /^released /);
  assert.match(listOf(repo, env)[0], /^lane-1 free detached at /);
  assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('locked'), 'the lock is gone');
  const again = claim(repo, 'next', older, env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(lines(again)[0], `lane: ${folder}`, 'the freed folder is reused');
});

test('--snapshot together with --branch is a usage error (exit 2) and makes no folder', () => {
  const { repo, older } = repoThatMovedOn();
  const result = tidy(['lane', 'claim', '--repo', repo, '--snapshot', '--branch', 'x', '--base', older], { env: laneEnv() });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /--snapshot takes no --branch/);
  assert.ok(!existsSync(poolPath(repo, 1)));
  assert.equal(git(repo, 'branch', '--list', 'x'), '');
});

test('two snapshots of the same commit may be held at once, each in its own folder', () => {
  const { repo, older } = repoThatMovedOn();
  const env = laneEnv();
  assert.equal(snapshotClaim(repo, older, env).status, 0);
  assert.equal(snapshotClaim(repo, older, env).status, 0);
  assert.deepEqual(listOf(repo, env), [`lane-1 busy snapshot ${older.slice(0, SHORT_SHA)}`, `lane-2 busy snapshot ${older.slice(0, SHORT_SHA)}`]);
});
