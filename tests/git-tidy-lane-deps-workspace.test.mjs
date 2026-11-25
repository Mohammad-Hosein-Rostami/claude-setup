// Tests of the deps cache next to a lockfile folder with a tracked package.json below it (lib/lane-prep.mjs): one install there writes several
// node_modules (a workspace, a `file:` link), so the folder gets no cache clone; and a git repository inside node_modules fails the install.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, commit, git } from './git-tidy-helpers.mjs';
import { claim, installLog, lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { sharedToolDir } from './shared-tools.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'a fake package manager is an executable script with a shebang' };
const NPM_PROBE = process.platform === 'win32' ? null : spawnSync('npm', ['--version'], { env: CLEAN_ENV, stdio: 'ignore' });
const NEEDS_NPM = { skip: NEEDS_CLONE.skip || POSIX_ONLY.skip || (NPM_PROBE?.status === 0 ? false : 'npm is not on PATH') };
const NEEDS_FAKE_PACKAGE_MANAGER = { skip: NEEDS_CLONE.skip || POSIX_ONLY.skip };
const WORKSPACE_MEMBER = 'packages/a';
const NESTED_PACKAGE = 'sub';
const NEXT_LOCKFILE_TEXT = '{"lockfileVersion":3,"next":true}';
const NEST_REPOSITORY_MESSAGE = 'node_modules/dep is a git repository inside node_modules';
// Fake pnpm: one `pnpm install` writes the root's node_modules and the member's, as a real workspace install does.
const FAKE_PNPM = `#!${process.execPath}\nconst fs = require('fs');\nfs.mkdirSync('node_modules/d', { recursive: true });\nfs.mkdirSync('${WORKSPACE_MEMBER}/node_modules/ad', { recursive: true });\n`;

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const claimJson = (repo, branch, env) => lane(['claim', '--repo', repo, '--branch', branch, '--base', head(repo), '--json'], env);
const installOf = (result, dir) => result.installs.find((install) => install.dir === dir);

/** Adds a tracked file and commits it. */
function track(repo, file, text) {
  writeFile(join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `add ${file}`);
}

/** An npm workspace whose root and member depend on two different `file:` packages of the same name (npm cannot hoist both). */
function npmWorkspaceRepo() {
  const repo = jsRepo();
  const files = {
    'vendor/dup1/package.json': '{"name":"dup","version":"1.0.0"}',
    'vendor/dup2/package.json': '{"name":"dup","version":"2.0.0"}',
    'package.json': `{"name":"root","version":"1.0.0","private":true,"workspaces":["${WORKSPACE_MEMBER}"],"dependencies":{"dup":"file:vendor/dup1"}}`,
    [`${WORKSPACE_MEMBER}/package.json`]: '{"name":"a","version":"1.0.0","dependencies":{"dup":"file:../../vendor/dup2"}}',
  };
  for (const [file, text] of Object.entries(files)) writeFile(join(repo, file), text);
  const env = { ...laneEnv(), PATH: CLEAN_ENV.PATH, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  const lock = spawnSync('npm', ['install', '--package-lock-only'], { cwd: repo, env: { ...CLEAN_ENV, ...env }, encoding: 'utf8' });
  assert.equal(lock.status, 0, lock.stderr);
  git(repo, 'add', '--', '.');
  git(repo, 'commit', '-q', '-m', 'add a workspace');
  return { repo, env };
}

test('an npm workspace with file: links: the second lane runs the install, so the member has its node_modules', NEEDS_NPM, () => {
  const { repo, env } = npmWorkspaceRepo();
  const first = claimJson(repo, 'a', env);
  const second = claimJson(repo, 'b', env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const results = [first, second].map(({ stdout }) => JSON.parse(stdout));
  assert.deepEqual(results.map(({ folder }) => folder), [poolPath(repo, 1), poolPath(repo, 2)]);
  assert.deepEqual(results.map(({ ready }) => ready), [true, true]);
  assert.equal(installOf(results[1], '.').outcome, 'installed', 'not cloned from the cache of the first lane');
  for (const { folder } of results) assert.ok(existsSync(join(folder, WORKSPACE_MEMBER, 'node_modules', 'dup')), `${folder} lacks the member's node_modules`);
});

test('a pnpm workspace: the second lane has the member node_modules that the install writes', NEEDS_FAKE_PACKAGE_MANAGER, () => {
  const repo = jsRepo();
  track(repo, 'package.json', '{}');
  track(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9.0');
  track(repo, `${WORKSPACE_MEMBER}/package.json`, '{}');
  const env = laneEnv({ pathFirst: [sharedToolDir({ pnpm: FAKE_PNPM })] });
  const first = claimJson(repo, 'a', env);
  const second = claimJson(repo, 'b', env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(second.stdout);
  assert.equal(result.folder, poolPath(repo, 2), 'a new slot, so nothing was kept');
  assert.equal(installOf(result, '.').outcome, 'installed');
  assert.ok(existsSync(join(result.folder, WORKSPACE_MEMBER, 'node_modules', 'ad')), 'the member\'s node_modules of the install');
  assert.ok(existsSync(join(result.folder, 'node_modules', 'd')));
});

test('a git repository inside node_modules fails the install of the next claim and is left whole', NEEDS_FAKE_PACKAGE_MANAGER, () => {
  const repo = jsRepo();
  commit(repo, 'package-lock.json', '{"lockfileVersion":3}');
  const env = laneEnv();
  const first = claim(repo, 'a', head(repo), env);
  assert.equal(first.status, 0, first.stderr);
  const folder = poolPath(repo, 1);
  const dependency = join(folder, 'node_modules', 'dep');
  mkdirSync(dependency, { recursive: true });
  git(dependency, 'init', '-q', '-b', 'main');
  git(dependency, 'commit', '-q', '--allow-empty', '-m', 'work only in this repository');
  assert.equal(lane(['release', '--repo', repo, '--folder', folder], env).status, 0);
  commit(repo, 'package-lock.json', NEXT_LOCKFILE_TEXT);

  const second = claim(repo, 'b', head(repo), env);
  assert.equal(second.status, 1, second.stdout);
  assert.ok((second.stdout + second.stderr).includes(NEST_REPOSITORY_MESSAGE), second.stdout + second.stderr);
  assert.ok(existsSync(join(realpathSync(dependency), '.git')), 'the repository is still there');
  assert.equal(git(dependency, 'log', '-1', '--format=%s'), 'work only in this repository');
  assert.equal(installLog(env).length, 1, 'the install of the second claim never ran');
});

test('a nested package.json with its own lockfile does not share the root install: the second lane clones the root from the cache', NEEDS_FAKE_PACKAGE_MANAGER, () => {
  const repo = jsRepo();
  commit(repo, 'package-lock.json', '{"lockfileVersion":3}');
  track(repo, `${NESTED_PACKAGE}/package.json`, '{}');
  track(repo, `${NESTED_PACKAGE}/package-lock.json`, '{"lockfileVersion":3,"nested":true}');
  const env = laneEnv();
  assert.equal(claimJson(repo, 'a', env).status, 0);
  const second = claimJson(repo, 'b', env);
  assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(second.stdout);
  assert.equal(installOf(result, '.').outcome, 'cloned');
  assert.equal(installOf(result, NESTED_PACKAGE).outcome, 'cloned');
  assert.equal(installLog(env).length, 2, 'only the first claim installed (the root and the nested folder)');
});
