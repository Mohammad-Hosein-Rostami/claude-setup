// Tests of the node_modules guard of lib/lane-prep.mjs for a lockfile folder whose name git C-quotes (non-ASCII, a double quote): a git
// repository in <folder>/node_modules/dep fails the next claim's install and is left whole, as it is for a plain ASCII folder name.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { jsRepo } from './git-tidy-lane-fill-helpers.mjs';

// No NEEDS_CLONE: the guard runs before any cache clone or install, so a checkout fill shows the bug as well.
const NPM_PROBE = process.platform === 'win32' ? null : spawnSync('npm', ['--version'], { env: CLEAN_ENV, stdio: 'ignore' });
const NEEDS_NPM = { skip: (process.platform === 'win32' && 'npm is a .cmd shim that spawnSync runs only through a shell') || (NPM_PROBE?.status === 0 ? false : 'npm is not on PATH') };
const NON_ASCII_FOLDER = 'pké'; // git clean prints it as "pk\303\251/..."
const DOUBLE_QUOTE_FOLDER = 'p"k'; // git clean prints it as "p\"k/..."; not a valid file name on Windows (NEEDS_NPM skips there)
const ASCII_FOLDER = 'pk';
const NEST_REPOSITORY_MESSAGE = 'is a git repository inside node_modules';
const KEPT_COMMIT = 'work only in this repository';
const FIRST_DEPENDENCY = 'vendor/dup1';
const NEXT_DEPENDENCY = 'vendor/dup2';

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const claim = (repo, branch, env) => lane(['claim', '--repo', repo, '--branch', branch, '--base', head(repo)], env);
const manifestText = (dependency) => `{"name":"root","version":"1.0.0","private":true,"dependencies":{"dup":"file:${dependency}"}}`;

/** Writes `<folder>/package.json` depending on `dependency` and its package-lock.json (offline npm: `file:` dependencies only). */
function writeLockedManifest(repo, folder, dependency, env) {
  writeFile(join(repo, folder, 'package.json'), manifestText(dependency));
  const lock = spawnSync('npm', ['install', '--package-lock-only'], { cwd: join(repo, folder), env: { ...CLEAN_ENV, ...env }, encoding: 'utf8' });
  assert.equal(lock.status, 0, lock.stderr);
}

/** A repo whose only lockfile lies in `folder`, with two `file:` packages of the same name so a lockfile change is one manifest edit. */
function lockfileFolderRepo(folder) {
  const repo = jsRepo();
  writeFile(join(repo, folder, FIRST_DEPENDENCY, 'package.json'), '{"name":"dup","version":"1.0.0"}');
  writeFile(join(repo, folder, NEXT_DEPENDENCY, 'package.json'), '{"name":"dup","version":"2.0.0"}');
  // The real npm, not the fake installers of laneEnv: only a real `npm ci` deletes node_modules, which is the loss the guard prevents.
  const env = { ...laneEnv(), PATH: CLEAN_ENV.PATH, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  writeLockedManifest(repo, folder, FIRST_DEPENDENCY, env);
  git(repo, 'add', '--', '.');
  git(repo, 'commit', '-q', '-m', 'add a lockfile folder');
  return { repo, env };
}

/** The claim after a lockfile change, with a git repository in `<folder>/node_modules/dep` of the released lane: its result and that repository. */
function claimOverNestedRepository(folder) {
  const { repo, env } = lockfileFolderRepo(folder);
  const first = claim(repo, 'a', env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const slot = poolPath(repo, 1);
  const dependency = join(slot, folder, 'node_modules', 'dep');
  mkdirSync(dependency, { recursive: true });
  git(dependency, 'init', '-q', '-b', 'main');
  git(dependency, 'commit', '-q', '--allow-empty', '-m', KEPT_COMMIT);
  const release = lane(['release', '--repo', repo, '--folder', slot], env);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  writeLockedManifest(repo, folder, NEXT_DEPENDENCY, env);
  git(repo, 'commit', '-q', '-a', '-m', 'change the lockfile');
  return { second: claim(repo, 'b', env), repo, dependency };
}

/** The claim is not ready (exit 1) for the nested repository, and that repository still has its commit. */
function assertGuardKeptRepository(folder) {
  const { second, repo, dependency } = claimOverNestedRepository(folder);
  // `git -C` from the repo, so a deleted folder is a failed log, never a test error; the subject check rules out the lane's own repo.
  const log = spawnSync('git', ['-C', dependency, 'log', '-1', '--format=%s'], { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
  const output = second.stdout + second.stderr;
  assert.deepEqual(
    { claimExit: second.status, repoLogExit: log.status, repoLogSubject: log.stdout.trim() },
    { claimExit: 1, repoLogExit: 0, repoLogSubject: KEPT_COMMIT },
    `claim output: ${output}`,
  );
  assert.ok(output.includes(NEST_REPOSITORY_MESSAGE), output);
}

test('a lockfile folder with a non-ASCII name: a git repository in its node_modules fails the next claim and is left whole', NEEDS_NPM, () => {
  assertGuardKeptRepository(NON_ASCII_FOLDER);
});

test('a lockfile folder with a double quote in its name: a git repository in its node_modules fails the next claim and is left whole', NEEDS_NPM, () => {
  assertGuardKeptRepository(DOUBLE_QUOTE_FOLDER);
});

test('a lockfile folder with a plain ASCII name: a git repository in its node_modules fails the next claim and is left whole', NEEDS_NPM, () => {
  assertGuardKeptRepository(ASCII_FOLDER);
});
