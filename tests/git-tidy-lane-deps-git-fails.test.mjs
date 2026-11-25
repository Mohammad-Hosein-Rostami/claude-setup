// Test of the node_modules guard of lib/lane-prep.mjs when git cannot list the untracked files: the folder is not ready and the git
// repository in node_modules/dep is left whole (an install would delete it), instead of the guard assuming there is none.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { sharedToolDir } from './shared-tools.mjs';

// The git stand-in is a sh script: POSIX only. No NEEDS_CLONE: the guard runs before any cache clone or install.
const NPM_PROBE = process.platform === 'win32' ? null : spawnSync('npm', ['--version'], { env: CLEAN_ENV, stdio: 'ignore' });
const NEEDS_NPM = { skip: (process.platform === 'win32' && 'npm is a .cmd shim and the git stand-in is a sh script') || (NPM_PROBE?.status === 0 ? false : 'npm is not on PATH') };
const FOLDER = '.';
const FIRST_DEPENDENCY = 'vendor/dup1';
const NEXT_DEPENDENCY = 'vendor/dup2';
const KEPT_COMMIT = 'work only in this repository';
const NOT_READY_EXIT = 1;
const LISTING_FAILURE_MESSAGE = 'git cannot list the untracked files';
// Fails both ways to list the untracked files (`ls-files --others`, and `clean -n` as the guard once did); any other call is the real git.
// `ls-files --others --ignored` is not the guard's listing (the pool's own ignored-entries scan runs it earlier in a claim): it passes.
const GIT_STAND_IN = [
  '#!/bin/sh',
  'has() { want=$1; shift; for arg in "$@"; do [ "$arg" = "$want" ] && return 0; done; return 1; }',
  'if { has ls-files "$@" && has --others "$@" && ! has --ignored "$@"; } || { has clean "$@" && has -n "$@"; }; then',
  '  echo "fatal: injected" >&2',
  '  exit 128',
  'fi',
  'exec "$REAL_GIT" "$@"',
  '',
].join('\n');

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const claim = (repo, branch, env) => lane(['claim', '--repo', repo, '--branch', branch, '--base', head(repo)], env);
const manifestText = (dependency) => `{"name":"root","version":"1.0.0","private":true,"dependencies":{"dup":"file:${dependency}"}}`;

/** Writes `package.json` depending on `dependency` and its package-lock.json (offline npm: `file:` dependencies only). */
function writeLockedManifest(repo, dependency, env) {
  writeFile(join(repo, 'package.json'), manifestText(dependency));
  const lock = spawnSync('npm', ['install', '--package-lock-only'], { cwd: join(repo, FOLDER), env: { ...CLEAN_ENV, ...env }, encoding: 'utf8' });
  assert.equal(lock.status, 0, lock.stderr);
}

/** The real git of the clean environment, which the stand-in runs for every call it does not fail. */
function realGit() {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: CLEAN_ENV, encoding: 'utf8' });
  assert.equal(found.status, 0, found.stderr);
  return found.stdout.trim();
}

test('a git that cannot list the untracked files fails the next claim as not ready and leaves a git repository in node_modules whole', NEEDS_NPM, () => {
  const repo = jsRepo();
  writeFile(join(repo, FIRST_DEPENDENCY, 'package.json'), '{"name":"dup","version":"1.0.0"}');
  writeFile(join(repo, NEXT_DEPENDENCY, 'package.json'), '{"name":"dup","version":"2.0.0"}');
  // The real npm, not the fake installers of laneEnv: only a real `npm ci` deletes node_modules, which is the loss the guard prevents.
  const env = { ...laneEnv(), PATH: CLEAN_ENV.PATH, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  writeLockedManifest(repo, FIRST_DEPENDENCY, env);
  git(repo, 'add', '--', '.');
  git(repo, 'commit', '-q', '-m', 'add a lockfile');
  const first = claim(repo, 'a', env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const slot = poolPath(repo, 1);
  const dependency = join(slot, 'node_modules', 'dep');
  mkdirSync(dependency, { recursive: true });
  git(dependency, 'init', '-q', '-b', 'main');
  git(dependency, 'commit', '-q', '--allow-empty', '-m', KEPT_COMMIT);
  const keptHead = head(dependency);
  const release = lane(['release', '--repo', repo, '--folder', slot], env);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  writeLockedManifest(repo, NEXT_DEPENDENCY, env);
  git(repo, 'commit', '-q', '-a', '-m', 'change the lockfile');

  const standIn = sharedToolDir({ git: GIT_STAND_IN });
  const second = claim(repo, 'b', { ...env, PATH: [standIn, CLEAN_ENV.PATH].join(delimiter), REAL_GIT: realGit() });

  // `git -C` from the repo with the real git, so a deleted folder is a failed log, never a test error.
  const log = spawnSync('git', ['-C', dependency, 'log', '-1', '--format=%H'], { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
  const output = second.stdout + second.stderr;
  assert.deepEqual(
    { claimExit: second.status, repoLogExit: log.status, repoLogHead: log.stdout.trim() },
    { claimExit: NOT_READY_EXIT, repoLogExit: 0, repoLogHead: keptHead },
    `claim output: ${output}`,
  );
  assert.ok(second.stderr.includes(LISTING_FAILURE_MESSAGE), output);
});
