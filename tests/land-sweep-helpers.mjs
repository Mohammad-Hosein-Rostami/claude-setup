// Shared fixtures for the tests of land's sweep (home/tools/land/sweep.mjs) and git-tidy's one content proof
// (home/tools/git-tidy/lib/branches.mjs `content-equal`, deletion-log.mjs): run `land` as a child process, commit at a chosen
// time, set when a worktree was last used, read the deletion log, and build the folds the tests start from.
// Exports: LAND, LOG_FILE, land, outputLines, branchExists, tipOf, gitWith, datedEnv, commitAt, usedAgo, logPath, logRecords,
//   logLines, addWorktreeAt, laneFixedOnTestBranch, laneSquashedOnTestBranch.
// Invariants: every repository is a throw-away one from git-tidy-helpers.mjs (temp folder, no user git config, private HOME);
//   git runs only inside the temp root and never through a shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, backdate, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { testTempRoot } from './temp-dir-helpers.mjs';

export const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
export const LOG_FILE = 'cs-tidy-log.jsonl'; // the deletion log's name inside the git common dir (deletion-log.mjs)
const TEMP_ROOT = realpathSync(testTempRoot());
const MS_PER_SECOND = 1000;
// `git rebase -i` with this editor keeps the todo list as git wrote it, so `--autosquash` runs without a person.
const KEEP_TODO = 'sequence.editor=true';

/** Runs land.mjs with `args` from `cwd`; returns the spawn result. */
export const land = (args, cwd) => spawnSync(process.execPath, [LAND, ...args], { cwd, encoding: 'utf8', env: CLEAN_ENV });

/** The non-empty lines of `output`. */
export const outputLines = (output) => output.split(/\r?\n/).filter((line) => line !== '');

export const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

export const tipOf = (repo, name) => git(repo, 'rev-parse', `refs/heads/${name}`);

/** git in `cwd` with extra environment variables (a commit date); fails the test on a non-zero exit. Returns trimmed stdout. */
export function gitWith(cwd, env, ...args) {
  assert.ok(cwd.startsWith(TEMP_ROOT + sep), `refusing to run git outside the temp folder: ${cwd}`);
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The author and committer date variables for `msAgo` milliseconds before now (git reads `<unix seconds> +0000`). */
export function datedEnv(msAgo) {
  const date = `${Math.floor((Date.now() - msAgo) / MS_PER_SECOND)} +0000`;
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

/** Writes and commits `file` in `dir`, dated `msAgo` before now; returns the full hash. */
export function commitAt(dir, file, text, msAgo) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '--', file);
  gitWith(dir, datedEnv(msAgo), 'commit', '-q', '-m', `add ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Sets every file prune's recent-use rule looks at (HEAD reflog, index, tracked files) of `worktree` to `msAgo` before now. */
export function usedAgo(worktree, msAgo) {
  const when = new Date(Date.now() - msAgo);
  const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir');
  const tracked = git(worktree, 'ls-files').split('\n').map((name) => join(worktree, name));
  for (const file of [join(gitDir, 'logs', 'HEAD'), join(gitDir, 'index'), ...tracked]) utimesSync(file, when, when);
}

/** The deletion log of `repo`. */
export const logPath = (repo) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), LOG_FILE);

/** The non-empty lines of the deletion log, as written; [] when there is none. */
export function logLines(repo) {
  const path = logPath(repo);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : [];
}

/** The parsed records of the deletion log (`{ deleted }`), [] when there is none. */
export function logRecords(repo) {
  const path = logPath(repo);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

/** `git worktree add` of a new branch `branch` started at `start`, in a sibling folder `name`; returns the real folder path. */
export function addWorktreeAt(repo, name, branch, start) {
  const path = join(repo, '..', name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, path, start);
  return realpathSync(path);
}

/**
 * A fold whose content lands as it is, but in another commit: `lane` (own worktree, one commit) continued on `test`, made at
 * its tip in its own worktree, with a test commit, then squashed into one commit (`reset --soft` to the base and commit). Once
 * `test` lands, every file of `lane` is on the base with the same content, while no commit or patch of `lane` is: only the
 * content proof (`content-equal`) deletes it. The lane's worktree was last used two hours ago (backdate). Returns
 * `{ repo, laneTree, testTree, laneTip, testTip }`.
 */
export function laneSquashedOnTestBranch({ lane = 'lane/x', test = 'test/x' } = {}) {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', lane);
  const laneTip = commit(laneTree, 'feature.txt', 'feature v1\n');
  const testTree = addWorktreeAt(repo, 'test', test, `refs/heads/${lane}`);
  commit(testTree, 'feature.test.txt', 'checks the feature\n');
  git(testTree, 'reset', '-q', '--soft', 'main');
  git(testTree, 'commit', '-q', '-m', 'feature and its test in one commit');
  backdate(laneTree);
  return { repo, laneTree, testTree, laneTip, testTip: tipOf(repo, test) };
}

/**
 * The observed fold (plan case a): `lane` (own worktree, one commit) continued on `test`, made at its tip in its own worktree,
 * with a test commit and a fixup of the lane's commit squashed in by `rebase -i --autosquash`. The lane's commit is then on no
 * branch but in `test`'s history, and its content (feature v1) is not on the base once `test` lands: `lane` must stay. `msAgo` dates every commit of `test` (the landed lane's last commit). The lane's worktree
 * was last used two hours ago (backdate), so only the content proof decides. Returns `{ repo, laneTree, testTree, laneTip, testTip }`.
 */
export function laneFixedOnTestBranch({ lane = 'lane/x', test = 'test/x', msAgo = 0 } = {}) {
  const repo = makeRepo();
  const laneTree = addWorktree(repo, 'lane', lane);
  const laneTip = commit(laneTree, 'feature.txt', 'feature v1\n');
  const testTree = addWorktreeAt(repo, 'test', test, `refs/heads/${lane}`);
  commitAt(testTree, 'feature.test.txt', 'checks the feature\n', msAgo);
  writeFileSync(join(testTree, 'feature.txt'), 'feature v2\n');
  git(testTree, 'add', '--', 'feature.txt');
  gitWith(testTree, datedEnv(msAgo), 'commit', '-q', `--fixup=${laneTip}`);
  gitWith(testTree, datedEnv(msAgo), '-c', KEEP_TODO, 'rebase', '-q', '-i', '--autosquash', 'main');
  backdate(laneTree);
  return { repo, laneTree, testTree, laneTip, testTip: tipOf(repo, test) };
}
