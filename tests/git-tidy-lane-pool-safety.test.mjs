// Tests of the lane pool's data-loss guards (review round of lane-pool): reclaim and a stale entry's removal never drop commits that only
// a HEAD reflog holds; a git repository inside an ignored folder survives a claim and a reclaim; the base branch is never a lane; a waiter
// on a stale lock whose breaker file is left behind gives up at its deadline instead of spinning.
import { existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { adminDir, backdateUse, claim, deadPid, lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { PoolBusy, withPoolLock } from '../home/tools/git-tidy/lib/pool-lock.mjs';

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const release = (repo, folder, env) => lane(['release', '--repo', repo, '--folder', folder], env);
const reclaim = (repo, env) => lane(['reclaim', '--repo', repo], env);
const keptLine = (result, slot) => lines(result).find((line) => line.startsWith(`kept ${slot} `)) ?? '';

/** Claims and releases `count` folders of `repo`, so they are free. */
function freeFolders(repo, count, env) {
  for (let number = 1; number <= count; number++) assert.equal(claim(repo, `l${number}`, head(repo), env).status, 0);
  for (let number = 1; number <= count; number++) assert.equal(release(repo, poolPath(repo, number), env).status, 0);
}

/** A commit made on the folder's detached HEAD, then left by switching back: only the HEAD reflog holds it. */
function reflogOnlyCommit(folder, base) {
  const lost = commit(folder, 'lost.txt');
  git(folder, 'switch', '-q', '--detach', base);
  return lost;
}

test('reclaim keeps an idle free folder whose HEAD reflog holds a commit found nowhere else; an idle one without it goes', () => {
  const repo = makeRepo();
  const env = laneEnv();
  freeFolders(repo, 2, env);
  const lost = reflogOnlyCommit(poolPath(repo, 1), head(repo));
  for (const number of [1, 2]) backdateUse(poolPath(repo, number));
  const result = reclaim(repo, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(keptLine(result, 'lane-1'), /its HEAD reflog holds 1 commits found nowhere else$/);
  assert.ok(existsSync(poolPath(repo, 1)) && !existsSync(poolPath(repo, 2)));
  assert.equal(git(repo, 'cat-file', '-t', lost), 'commit');
});

test('claim never removes a stale entry whose reflog holds a commit found nowhere else; it adds a new folder and keeps the entry', () => {
  const repo = makeRepo();
  const env = laneEnv();
  freeFolders(repo, 1, env);
  const folder = poolPath(repo, 1);
  const lost = reflogOnlyCommit(folder, head(repo));
  const entry = adminDir(folder);
  rmSync(folder, { recursive: true, force: true });
  const result = claim(repo, 'next', head(repo), env);
  assert.equal(lines(result)[0], `lane: ${poolPath(repo, 2)}`);
  assert.ok(existsSync(join(entry, 'logs', 'HEAD')), 'the entry and its reflog stay');
  assert.ok(git(repo, 'reflog', 'show', '--format=%H', `worktrees/${entry.split(/[\\/]/).at(-1)}/HEAD`).split('\n').includes(lost));
});

test('claim recreates a stale entry whose reflog holds nothing found nowhere else (same number)', () => {
  const repo = makeRepo();
  const env = laneEnv();
  freeFolders(repo, 1, env);
  rmSync(poolPath(repo, 1), { recursive: true, force: true });
  assert.equal(lines(claim(repo, 'next', head(repo), env))[0], `lane: ${poolPath(repo, 1)}`);
});

test('a git repository inside an ignored folder survives a claim of its folder, and reclaim keeps that folder', () => {
  const repo = makeRepo();
  commit(repo, '.gitignore', 'scratch/\nnode_modules/\n');
  const env = laneEnv();
  freeFolders(repo, 2, env);
  const nested = join(poolPath(repo, 1), 'scratch');
  git(repo, 'init', '-q', nested);
  const mine = commit(nested, 'mine.txt');
  writeFile(join(poolPath(repo, 2), 'node_modules', 'dep.js'), 'x');
  assert.equal(lines(claim(repo, 'b', head(repo), env))[0], `lane: ${poolPath(repo, 1)}`);
  assert.equal(head(nested), mine, 'the clean kept the nested repository');
  assert.equal(release(repo, poolPath(repo, 1), env).status, 0);
  for (const number of [1, 2]) backdateUse(poolPath(repo, number));
  const result = reclaim(repo, env);
  assert.match(keptLine(result, 'lane-1'), /a git repository inside an ignored folder \(scratch\/\)$/);
  assert.equal(head(nested), mine);
  assert.ok(!existsSync(poolPath(repo, 2)), 'an ignored node_modules alone does not keep a folder');
});

test('the base branch is never a lane: claim refuses it, release refuses a folder holding it and never deletes it', () => {
  const repo = makeRepo();
  const base = head(repo);
  git(repo, 'config', 'branch.main.cs-base', 'true'); // main served as a base (a git-tidy run there marks it)
  git(repo, 'switch', '-q', '-c', 'other');
  const env = laneEnv();
  const refused = claim(repo, 'main', base, env);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /main is a base branch of this repository, never a lane/);
  assert.ok(!existsSync(join(repo, '.claude')));
  const folder = poolPath(repo, 1);
  git(repo, 'worktree', 'add', '-q', folder, 'main');
  git(repo, 'worktree', 'lock', '--reason', 'cs-lane-pool main', folder);
  const kept = release(repo, folder, env);
  assert.equal(kept.status, 3);
  assert.match(kept.stdout, /holds the base branch main, which is never a lane/);
  assert.equal(git(repo, 'rev-parse', '--verify', 'refs/heads/main'), base);
});

test('a stale lock whose breaker file is left behind: the waiter pauses and gives up at its deadline (no spin)', () => {
  const repo = makeRepo();
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const lockPath = join(common, 'cs-lane-pool.lock');
  writeFileSync(lockPath, `${deadPid()} ${'0'.repeat(32)} claim gone`);
  const seen = lstatSync(lockPath);
  writeFileSync(`${lockPath}.break-${seen.ino}-${Math.trunc(seen.mtimeMs)}`, '1'); // a breaker that crashed a moment ago
  let clock = Date.now();
  let reads = 0;
  const now = () => { reads += 1; clock += 10; return clock; };
  assert.throws(() => withPoolLock(common, 'test', () => 'ran', { waitMs: 300, now }), PoolBusy);
  assert.ok(reads < 200, `the wait read the clock ${reads} times`);
  assert.ok(existsSync(lockPath), 'the lock stays for the breaker that owns it');
});
