// Shared fixtures for the git-tidy tests: build throw-away git repos in temp folders and run the CLI on them.
// Exports: CLI, CLEAN_ENV, makeRepo, git, commit, addWorktree, backdate, tidy, lines, snapshot, withOrigin.
// Invariants: every git call gets an explicit cwd inside the OS temp folder (checked in `git`) and an environment without
//   GIT_* variables (under the pre-commit hook git sets GIT_DIR, which would point a child git at the real repo) and
//   without the user's git config, so a test can never read or change the repository the tests run from. HOME is a private empty folder
//   and no session id is set, so a child process never reads the real session's state (~/.claude/state/<tool>/<id>.json).
import { spawnSync } from 'node:child_process';
import { realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makeTempDir, testTempRoot } from './temp-dir-helpers.mjs';

export const CLI = fileURLToPath(new URL('../home/tools/git-tidy/git-tidy.mjs', import.meta.url));
const TEMP_ROOT = realpathSync(testTempRoot()); // where makeTempDir makes every test folder
const NO_GIT_CONFIG = { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const PINNED_HOME = makeTempDir('git-tidy-home-');
const SESSION_ID_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']; // the session-store readers use both
export const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !SESSION_ID_VARIABLES.includes(name))),
  ...NO_GIT_CONFIG,
  ...IDENTITY,
  HOME: PINNED_HOME,
  USERPROFILE: PINNED_HOME,
};

/** Runs git in `cwd` (must be inside the temp folder) and returns trimmed stdout; fails the test on a non-zero exit. */
export function git(cwd, ...args) {
  assert.ok(cwd.startsWith(TEMP_ROOT + sep), `refusing to run git outside the temp folder: ${cwd}`);
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A new repo on branch `main` with one commit; returns its real path. */
export function makeRepo() {
  const dir = join(realpathSync(makeTempDir('git-tidy-')), 'repo');
  const parent = join(dir, '..');
  git(parent, 'init', '-q', '-b', 'main', dir);
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'base.txt');
  return dir;
}

/** Writes `file` (default: its name as text), commits it with `message` and returns the full hash. */
export function commit(dir, file, text = file, message = `add ${file}`) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** `git worktree add` of a new or existing branch in a sibling folder `name`; returns the real folder path. */
export function addWorktree(dir, name, branch, { create = true } = {}) {
  const path = join(dir, '..', name);
  if (create) git(dir, 'worktree', 'add', '-q', '-b', branch, path);
  else git(dir, 'worktree', 'add', '-q', path, branch);
  return realpathSync(path);
}

/** Sets every file a "recently used" test looks at (tracked files, index, HEAD reflog) to two hours ago. */
export function backdate(worktree) {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir');
  const tracked = git(worktree, 'ls-files').split('\n').map((name) => join(worktree, name));
  for (const file of [join(gitDir, 'logs', 'HEAD'), join(gitDir, 'index'), ...tracked]) utimesSync(file, old, old);
}

/** Runs the CLI with `args`; the folder `cwd` is where it runs from. Returns the spawn result. */
export const tidy = (args, { cwd, env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, ...env }, maxBuffer: 64 << 20 });

/** The non-empty output lines. */
export const lines = (result) => result.stdout.split('\n').filter((line) => line !== '');

/** Everything a plan must leave alone: all refs, the worktree list and the status of each given folder. */
export const snapshot = (dir, ...folders) =>
  [git(dir, 'for-each-ref'), git(dir, 'worktree', 'list', '--porcelain'), ...[dir, ...folders].map((f) => git(f, 'status', '--porcelain'))].join('\n--\n');

/** A bare `origin` next to the repo, `main` pushed and set as the upstream of main. Returns the origin folder. */
export function withOrigin(dir) {
  const origin = join(dir, '..', 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return origin;
}
