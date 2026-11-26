// Tests of `git-tidy lane` (lib/lane-pool.mjs, lane-slots.mjs, pool-lock.mjs, lane-prep.mjs, lane-cli.mjs): claim, list, release, reclaim,
// land's detach, the pool lock, the job-made record, the installs a claim runs, and `check`'s info lines. Every repo is a temp repo.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI, CLEAN_ENV, commit, git, makeRepo, tidy, lines } from './git-tidy-helpers.mjs';
import { adminDir, backdateUse, claim, deadPid, installLog, lane, laneEnv, poolPath, snapshot, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { PoolBusy, withPoolLock } from '../home/tools/git-tidy/lib/pool-lock.mjs';
import { readJobMade, stillMade } from '../home/tools/disk-free/lib/job-made.mjs';

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const release = (repo, folder, env) => lane(['release', '--repo', repo, '--folder', folder], env);
const listOf = (repo, env) => lines(lane(['list', '--repo', repo], env));
const lockReasonOf = (repo, folder) => {
  const fields = git(repo, 'worktree', 'list', '--porcelain', '-z').split('\0');
  const at = fields.findIndex((field) => field === `worktree ${folder}`);
  return fields.slice(at + 1).find((field) => field.startsWith('locked') || field.startsWith('worktree ')) ?? '';
};
/** A repo whose .gitignore ignores node_modules, dist and .env (as a JS project's does). */
function jsRepo() {
  const dir = makeRepo();
  commit(dir, '.gitignore', 'node_modules/\ndist/\n.env\n');
  return dir;
}

test('claim: lane-1 at the base on a new branch, locked; output names the folder, kept and installs', () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  const result = claim(repo, 'feat/a', base, env);
  assert.equal(result.status, 0, result.stderr);
  const folder = poolPath(repo, 1);
  const output = lines(result);
  assert.deepEqual(output.slice(0, 3), [`lane: ${folder}`, 'kept: none', 'installed: none']);
  assert.equal(output.length, 4, result.stdout);
  assert.match(output[3], /^fill: (clone \d+\.\d s, \d+ entries, repaired 0|checkout \(.+\))$/); // checkout where cloning is not possible
  assert.equal(git(folder, 'symbolic-ref', 'HEAD'), 'refs/heads/feat/a');
  assert.equal(head(folder), base);
  assert.equal(lockReasonOf(repo, folder), 'locked cs-lane-pool feat/a');
  const made = stillMade(readJobMade(env).sessions);
  assert.deepEqual(made.map(({ kind, key, by }) => [kind, key, by]), [['lane-folder', folder, 'git-tidy lane claim']]);
});

test('free folders are reused lowest first; when all are busy the lowest unused lane-<n> is added (no cap)', () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  for (const branch of ['a', 'b', 'c']) assert.equal(claim(repo, branch, base, env).status, 0);
  assert.ok(existsSync(poolPath(repo, 3)));
  for (const number of [3, 1]) assert.equal(release(repo, poolPath(repo, number), env).status, 0);
  assert.equal(git(repo, 'branch', '--list', 'a', 'c'), '', 'release deletes the landed branches');
  assert.equal(lines(claim(repo, 'd', base, env))[0], `lane: ${poolPath(repo, 1)}`);
  assert.equal(lines(claim(repo, 'e', base, env))[0], `lane: ${poolPath(repo, 3)}`);
  assert.equal(lines(claim(repo, 'f', base, env))[0], `lane: ${poolPath(repo, 4)}`);
  assert.deepEqual(listOf(repo, env).map((line) => line.split(' ').slice(0, 2).join(' ')), ['lane-1 busy', 'lane-2 busy', 'lane-3 busy', 'lane-4 busy']);
});

test('busy folders are never switched, cleaned or removed: each kind is untouched byte for byte and named by list', () => {
  const repo = makeRepo();
  commit(repo, 'two.txt');
  const base = head(repo);
  const env = laneEnv();
  const folders = [1, 2, 3, 4, 5].map((number) => poolPath(repo, number));
  for (const folder of folders) git(repo, 'worktree', 'add', '-q', '--detach', folder, base);
  writeFileSync(join(folders[0], 'new.txt'), 'untracked');
  writeFileSync(join(folders[1], 'base.txt'), 'changed');
  commit(folders[2], 'only-here.txt');
  writeFileSync(join(adminDir(folders[3]), 'index.lock'), '');
  const rebase = spawnRebaseStop(folders[4]);
  assert.notEqual(rebase.status, 0, 'the exec step stops the rebase');
  const stranger = poolPath(repo, 6);
  writeFile(join(stranger, 'mine.txt'), 'not a worktree');
  const watched = [...folders, stranger, ...folders.map(adminDir)];
  const before = watched.map((folder) => snapshot(folder));
  const result = claim(repo, 'lane-x', base, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lines(result)[0], `lane: ${poolPath(repo, 7)}`);
  assert.deepEqual(watched.map((folder) => snapshot(folder)), before);
  const why = listOf(repo, env);
  assert.match(why[0], /^lane-1 busy 1 uncommitted or untracked files$/);
  assert.match(why[1], /^lane-2 busy 1 uncommitted or untracked files$/);
  assert.match(why[2], /^lane-3 busy HEAD \w{8} has commits that are not on main$/);
  assert.match(why[3], /^lane-4 busy a git lock is held \(index\.lock\)$/);
  assert.match(why[4], /^lane-5 busy a rebase is not finished there$/);
  assert.match(why[5], /^lane-6 busy not a worktree of this repository: never touched$/);
  for (const folder of [...folders, stranger]) assert.equal(release(repo, folder, env).status, 3, folder);
  assert.deepEqual(watched.map((folder) => snapshot(folder)), before, 'release refuses them all, byte for byte');
});

/** A real rebase stopped by a failing exec step: HEAD detached at a base commit, nothing changed, the rebase unfinished. */
function spawnRebaseStop(folder) {
  return spawnSyncGit(folder, ['rebase', '--exec', 'git rev-parse --verify --quiet refs/heads/none', 'HEAD~1']);
}
const spawnSyncGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' } });

test('hostile branch names and a bad sha are refused before any write (exit 2)', () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  for (const branch of ['-x', 'a..b', 'refs/heads/x', 'a b', 'x@{1}']) {
    const result = claim(repo, branch, base, env);
    assert.equal(result.status, 2, `${branch}: ${result.stdout}`);
    assert.match(result.stderr, /not a plain branch name/);
  }
  assert.equal(claim(repo, 'ok', base.slice(0, 12), env).status, 2);
  assert.equal(claim(repo, 'ok', 'f'.repeat(40), env).status, 2);
  assert.ok(!existsSync(join(repo, '.claude')), 'no folder was made');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
});

test('re-done lane: an existing branch is switched to as it is (no reset); one checked out in another folder exits 2 naming it', () => {
  const repo = makeRepo();
  const base = head(repo);
  git(repo, 'switch', '-q', '-c', 'redo');
  const tip = commit(repo, 'work.txt');
  git(repo, 'switch', '-q', 'main');
  const env = laneEnv();
  const result = claim(repo, 'redo', base, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(head(poolPath(repo, 1)), tip);
  const again = claim(repo, 'redo', base, env);
  assert.equal(again.status, 2);
  assert.ok(again.stderr.includes(`checked out in ${poolPath(repo, 1)}`), again.stderr);
  git(repo, 'switch', '-q', '-c', 'side'); // the branch the main folder holds is the base: never a lane
  const inMain = claim(repo, 'side', base, env);
  assert.equal(inMain.status, 2);
  assert.ok(inMain.stderr.includes('side is a base branch of this repository, never a lane'), inMain.stderr);
});

test('a reused folder keeps node_modules while the lockfiles are equal, loses it when one changed; dist/ and .env always go', () => {
  const repo = jsRepo();
  commit(repo, 'package-lock.json', '{"v":1}');
  const env = laneEnv();
  const folder = poolPath(repo, 1);
  assert.equal(claim(repo, 'a', head(repo), env).status, 0);
  for (const file of ['node_modules/own.txt', 'dist/out.js', '.env']) writeFile(join(folder, file), 'x');
  assert.equal(release(repo, folder, env).status, 0);
  const kept = claim(repo, 'b', head(repo), env);
  assert.deepEqual(lines(kept).slice(0, 3), [`lane: ${folder}`, 'kept: node_modules', 'installed: none']);
  assert.ok(existsSync(join(folder, 'node_modules', 'own.txt')));
  assert.ok(!existsSync(join(folder, 'dist')) && !existsSync(join(folder, '.env')));
  assert.equal(release(repo, folder, env).status, 0);
  commit(repo, 'package-lock.json', '{"v":2}');
  const changed = claim(repo, 'c', head(repo), env);
  assert.equal(lines(changed)[1], 'kept: none');
  assert.ok(!existsSync(join(folder, 'node_modules', 'own.txt')), 'removed by the clean');
  assert.equal(lines(changed)[2], 'installed: npm ci in .', 'and installed again for the new lockfile');
});

test('lane-prep: each tracked lockfile gets its own install in its folder; the same lockfile hash is skipped next time', () => {
  const repo = jsRepo();
  writeFile(join(repo, 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  writeFile(join(repo, 'app', 'yarn.lock'), '# yarn');
  commit(repo, 'package-lock.json', '{}');
  git(repo, 'add', 'web', 'app');
  git(repo, 'commit', '-q', '-m', 'lockfiles');
  const env = laneEnv();
  const folder = poolPath(repo, 1);
  assert.equal(claim(repo, 'a', head(repo), env).status, 0);
  assert.deepEqual(installLog(env).map(({ program, args, cwd }) => [program, args.join(' '), cwd]), [
    ['npm', 'ci', folder], ['yarn', 'install --immutable', join(folder, 'app')], ['pnpm', 'install --frozen-lockfile', join(folder, 'web')],
  ]);
  assert.equal(release(repo, folder, env).status, 0);
  const again = claim(repo, 'b', head(repo), env);
  assert.deepEqual(lines(again).slice(1, 3), ['kept: node_modules', 'installed: none']);
  assert.equal(installLog(env).length, 3, 'no install ran the second time');
});

test('lane-prep: an install failure exits 1 with the "lane not ready" lines and the folder is not handed out', () => {
  const repo = jsRepo();
  commit(repo, 'package-lock.json', '{}');
  const env = laneEnv({ fail: true });
  const result = claim(repo, 'a', head(repo), env);
  const folder = poolPath(repo, 1);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', 'no lane: line');
  // The first claim in a repository also keeps the pool out of its git status (2d9c4bb5) and says so before the failure lines.
  const [notice, first, second, third, fourth] = result.stderr.trim().split('\n');
  assert.match(notice, /^git-tidy: added \/\.claude\/worktrees\/ to .*exclude so lane folders stay out of git status$/);
  assert.ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/.claude/worktrees/'), 'the pool is excluded');
  assert.match(first, /^lane not ready: npm ci failed in \.: exit 1: fake npm broke$/);
  assert.equal(second, `  worktree: ${folder} (branch a)`);
  assert.ok(third.startsWith('  to finish:  cd ') && third.endsWith(' && npm ci'), third);
  assert.ok(fourth.startsWith('  to release: node ') && fourth.includes('lane release'), fourth);
  assert.match(listOf(repo, env)[0], /^lane-1 busy locked \(cs-lane-pool a\)$/);
});

test('lane-prep: a package manager inside the lane folder or on a relative PATH entry is never run', () => {
  const repo = jsRepo();
  writeFile(join(repo, 'bin', 'npm'), `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.FAKE_INSTALL_LOG, '{"program":"repo"}\\n');\n`);
  git(repo, 'update-index', '--add', '--chmod=+x', 'bin/npm');
  commit(repo, 'package-lock.json', '{}');
  const env = laneEnv({ pathFirst: [join(poolPath(repo, 1), 'bin'), 'bin'] });
  assert.equal(claim(repo, 'a', head(repo), env).status, 0);
  assert.deepEqual(installLog(env).map(({ program }) => program), ['npm']);
});

test('land leaves a pool folder detached at the landed sha, unlocked, with the branch gone; list shows it free', () => {
  const repo = makeRepo();
  const env = laneEnv();
  assert.equal(claim(repo, 'feat/land', head(repo), env).status, 0);
  const folder = poolPath(repo, 1);
  const tip = commit(folder, 'feature.txt');
  const landed = tidy(['land', 'feat/land', repo, '--tip', tip], { env });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.ok(lines(landed).includes(`lane folder ${folder} detached at ${tip} (kept for the next lane)`), landed.stdout);
  assert.equal(head(repo), tip);
  assert.equal(head(folder), tip);
  assert.equal(spawnSyncGit(folder, ['symbolic-ref', '-q', 'HEAD']).status, 1, 'detached');
  assert.equal(git(repo, 'branch', '--list', 'feat/land'), '');
  assert.equal(lockReasonOf(repo, folder), '');
  assert.match(listOf(repo, env)[0], /^lane-1 free detached at /);
});

test('check: idle lane folders holding node_modules are one info line, no finding or hint; a fresh claimed lane is info', () => {
  const repo = jsRepo();
  const env = laneEnv();
  for (const branch of ['a', 'b', 'c']) assert.equal(claim(repo, branch, head(repo), env).status, 0);
  const fresh = check(repo);
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.ok(lines(fresh).includes(`not started: a in ${poolPath(repo, 1)} (locked, no commit of its own yet)`), fresh.stdout);
  for (const number of [1, 2, 3]) {
    writeFile(join(poolPath(repo, number), 'node_modules', 'dep', 'index.js'), 'x');
    assert.equal(release(repo, poolPath(repo, number), env).status, 0);
  }
  const idle = check(repo);
  assert.equal(idle.status, 0, idle.stdout);
  assert.deepEqual(lines(idle).filter((line) => line.startsWith('lane folders')), ['lane folders: 3 free']);
  assert.ok(!lines(idle).some((line) => line.startsWith('ignored-files?')), idle.stdout);
  assert.match(lines(idle).at(-1), /^git-tidy: 0 findings, 0 hints/);
});
const check = (repo) => tidy(['check', repo]);

test('two processes claiming at once get two folders', async () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = { ...CLEAN_ENV, ...laneEnv() };
  const run = (branch) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'lane', 'claim', '--repo', repo, '--branch', branch, '--base', base], { env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolve({ status, out }));
  });
  const results = await Promise.all([run('one'), run('two')]);
  assert.deepEqual(results.map(({ status }) => status), [0, 0]);
  const folders = results.map(({ out }) => out.split('\n')[0]).sort();
  assert.deepEqual(folders, [`lane: ${poolPath(repo, 1)}`, `lane: ${poolPath(repo, 2)}`]);
});

test('pool lock: a dead pid or an over-age lock is taken over; a live holder is never taken (PoolBusy)', () => {
  const repo = makeRepo();
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const lockPath = join(common, 'cs-lane-pool.lock');
  writeFileSync(lockPath, `${deadPid()} ${'0'.repeat(32)} claim gone`);
  assert.equal(claim(repo, 'a', head(repo), laneEnv()).status, 0, 'a dead holder is stale');
  assert.ok(!existsSync(lockPath), 'the claim released its own lock');
  writeFileSync(lockPath, `${process.pid} ${'1'.repeat(32)} claim live`);
  assert.throws(() => withPoolLock(common, 'test', () => 'ran', { waitMs: 200 }), PoolBusy);
  assert.ok(existsSync(lockPath), 'the live lock stays');
  const now = Date.now();
  assert.equal(withPoolLock(common, 'test', () => 'ran', { waitMs: 200, now: () => now + 121_000 }), 'ran', 'over 120 s old is stale');
});

test('reclaim removes only idle, clean, landed, unlocked folders, keeps the lowest free one of a used repo, and records them gone', () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  for (const branch of ['a', 'b', 'c', 'd', 'busy']) assert.equal(claim(repo, branch, base, env).status, 0);
  for (const number of [1, 2, 3, 4]) assert.equal(release(repo, poolPath(repo, number), env).status, 0);
  writeFileSync(join(poolPath(repo, 4), 'draft.txt'), 'keep me');
  for (const number of [1, 2, 3, 4]) backdateUse(poolPath(repo, number));
  const used = lane(['reclaim', '--repo', repo], env);
  assert.equal(used.status, 0, used.stderr);
  assert.deepEqual([1, 2, 3, 4, 5].map((number) => existsSync(poolPath(repo, number))), [true, false, false, true, true]);
  assert.match(lines(used).find((line) => line.startsWith('kept lane-1 ')), /lowest free folder of a repository used in the last 24 h/);
  const gone = stillMade(readJobMade(env).sessions).map(({ key }) => key);
  assert.ok(!gone.includes(poolPath(repo, 2)) && gone.includes(poolPath(repo, 1)), gone.join('\n'));
  assert.equal(release(repo, poolPath(repo, 5), env).status, 0);
  backdateUse(poolPath(repo, 5));
  const idle = lane(['reclaim', '--repo', repo], env);
  assert.equal(idle.status, 0, idle.stderr);
  assert.deepEqual([1, 4, 5].map((number) => existsSync(poolPath(repo, number))), [false, true, false], 'no use in 24 h: no folder kept for it');
});
