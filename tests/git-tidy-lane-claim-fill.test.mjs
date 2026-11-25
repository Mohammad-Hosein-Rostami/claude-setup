// Tests of `git-tidy lane claim` in clone mode (lib/lane-pool.mjs, lane-fill-state.mjs, lane-cli.mjs): two claims at once, a claim killed during
// its fill, the reuse of a released slot, and the `fill:` line and JSON field of the claim.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI, CLEAN_ENV, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { claim, lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo, waitForFile } from './git-tidy-lane-fill-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'a process group and a sh -c filter are POSIX' };
const FILL_LINE = /^fill: clone \d+\.\d s, \d+ entries, repaired \d+$/;
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const commonDirOf = (repo) => git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const listOf = (repo, env) => lines(lane(['list', '--repo', repo], env));
const release = (repo, folder, env) => lane(['release', '--repo', repo, '--folder', folder], env);

/** Runs `lane claim` as a child that starts at once; resolves `{ status, stdout, stderr }` when it ends. */
function claimAsync(repo, branch, base, env) {
  const child = spawn(process.execPath, [CLI, 'lane', 'claim', '--repo', repo, '--branch', branch, '--base', base, '--json'], { env: { ...CLEAN_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('two claims started together get two different slots, both with a clean status and no fill file left', async () => {
  const repo = jsRepo();
  writeFile(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  writeFile(join(repo, '.env'), 'SECRET=local');
  const base = head(repo);
  const env = laneEnv();
  const results = await Promise.all([claimAsync(repo, 'one', base, env), claimAsync(repo, 'two', base, env)]);
  assert.deepEqual(results.map(({ status, stderr }) => [status, stderr]), [[0, ''], [0, '']]);
  const folders = results.map(({ stdout }) => JSON.parse(stdout).folder).sort();
  assert.deepEqual(folders, [poolPath(repo, 1), poolPath(repo, 2)]);
  for (const folder of folders) assert.equal(git(folder, 'status', '--porcelain'), '', folder);
  assert.deepEqual(readdirSync(join(commonDirOf(repo), 'cs-lane-fill')), [], 'every claim deleted its fill file');
  assert.deepEqual(listOf(repo, env).map((line) => line.split(' ').slice(0, 2).join(' ')), ['lane-1 busy', 'lane-2 busy']);
});

/**
 * A repo whose `*.hang` files go through a clean filter that blocks while `block` exists. The slot's refresh of its index runs the
 * filter, so a claim stops inside its fill at a point the test controls; the filter writes its pid into `started` and waits.
 */
function repoWithBlockingFilter() {
  const repo = jsRepo();
  const tools = makeTempDir('lane-fill-filter-');
  const filter = join(tools, 'filter.js');
  const block = join(tools, 'block');
  const started = join(tools, 'started');
  writeFileSync(filter, [
    `const fs = require('fs');`,
    `if (fs.existsSync(process.argv[2])) { fs.writeFileSync(process.argv[3], String(process.pid)); setInterval(() => {}, 1 << 30); }`,
    `else process.stdin.pipe(process.stdout);`,
  ].join('\n'));
  writeFileSync(block, '');
  writeFile(join(repo, '.gitattributes'), '*.hang filter=hang\n');
  writeFile(join(repo, 'a.hang'), 'content\n');
  git(repo, 'add', '--', '.gitattributes', 'a.hang');
  git(repo, 'commit', '-q', '-m', 'add a hanging file');
  const command = [process.execPath, filter, block, started].map((part) => `'${part}'`).join(' ');
  git(repo, 'config', 'filter.hang.clean', command);
  return { repo, block, started };
}

test('a claim killed during its fill leaves a broken slot; the next claim takes that slot and ends clean', { skip: NEEDS_CLONE.skip || POSIX_ONLY.skip }, async () => {
  const { repo, block, started } = repoWithBlockingFilter();
  const base = head(repo);
  const env = laneEnv();
  const folder = poolPath(repo, 1);
  const waiting = waitForFile(started);
  const child = spawn(process.execPath, [CLI, 'lane', 'claim', '--repo', repo, '--branch', 'feat/killed', '--base', base], { env: { ...CLEAN_ENV, ...env }, stdio: 'ignore', detached: true });
  const ended = new Promise((resolve) => child.on('close', resolve));
  await waiting;
  assert.match(listOf(repo, env)[0], /^lane-1 filling feat\/killed pid \d+$/, 'while the fill runs the slot is filling');
  process.kill(-child.pid, 'SIGKILL'); // the claim and the git and filter processes under it, as when a session is killed
  await ended;
  assert.match(listOf(repo, env)[0], /^lane-1 broken the fill of feat\/killed by pid \d+ stopped$/);
  assert.equal(git(repo, 'branch', '--list', 'feat/killed'), '', 'the killed claim never made its branch');

  rmSync(block); // the filter lets the next fill through
  const next = claim(repo, 'feat/next', base, env);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(lines(next)[0], `lane: ${folder}`, 'the broken slot is taken before a new one is added');
  assert.match(next.stderr, /lane-1 was broken .* emptied and filled again/);
  assert.equal(git(folder, 'symbolic-ref', 'HEAD'), 'refs/heads/feat/next');
  assert.equal(git(folder, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(folder, 'a.hang'), 'utf8'), 'content\n');
  assert.deepEqual(readdirSync(join(commonDirOf(repo), 'cs-lane-fill')), []);
  assert.match(listOf(repo, env)[0], /^lane-1 busy /);
});

test('a released slot is reused: node_modules stays while no lockfile changed, and .env and dist come back from the main checkout', NEEDS_CLONE, () => {
  const repo = jsRepo();
  commit(repo, 'package-lock.json', '{"v":1}');
  writeFile(join(repo, '.env'), 'SECRET=main');
  writeFile(join(repo, 'dist', 'out.js'), 'built in main');
  const env = laneEnv();
  const folder = poolPath(repo, 1);
  assert.equal(claim(repo, 'a', head(repo), env).status, 0);
  writeFile(join(folder, 'node_modules', 'lane-only.txt'), 'installed in the lane');
  writeFile(join(folder, '.env'), 'SECRET=edited in the lane');
  rmSync(join(folder, 'dist'), { recursive: true });
  assert.equal(release(repo, folder, env).status, 0);

  const reused = claim(repo, 'b', head(repo), env);
  assert.equal(reused.status, 0, reused.stderr);
  assert.deepEqual(lines(reused).slice(0, 3), [`lane: ${folder}`, 'kept: node_modules', 'installed: none']);
  assert.equal(readFileSync(join(folder, 'node_modules', 'lane-only.txt'), 'utf8'), 'installed in the lane');
  assert.equal(readFileSync(join(folder, '.env'), 'utf8'), 'SECRET=main');
  assert.equal(readFileSync(join(folder, 'dist', 'out.js'), 'utf8'), 'built in main');
  assert.equal(git(folder, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(commonDirOf(repo), 'cs-lane-fill', 'lane-1.json')));
});

test('lane claim prints a fill: line with the clone seconds, entries and repairs, and --json has fill.mode clone', NEEDS_CLONE, () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = laneEnv();
  const text = claim(repo, 'a', base, env);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(lines(text).length, 4, text.stdout);
  assert.match(lines(text)[3], FILL_LINE);
  const json = lane(['claim', '--repo', repo, '--branch', 'b', '--base', base, '--json'], env);
  assert.equal(json.status, 0, json.stderr);
  const { fill } = JSON.parse(json.stdout);
  assert.equal(fill.mode, 'clone');
  assert.equal(typeof fill.entries, 'number');
});

test('with GIT_TIDY_LANE_FILL=checkout the claim prints fill: checkout (reason) and --json has fill.mode checkout', () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = { ...laneEnv(), GIT_TIDY_LANE_FILL: 'checkout' };
  const text = claim(repo, 'a', base, env);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(lines(text)[3], 'fill: checkout (GIT_TIDY_LANE_FILL=checkout)');
  const json = lane(['claim', '--repo', repo, '--branch', 'b', '--base', base, '--json'], env);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).fill.mode, 'checkout');
  assert.equal(git(poolPath(repo, 1), 'status', '--porcelain'), '');
  assert.ok(existsSync(join(poolPath(repo, 1), 'base.txt')));
});
