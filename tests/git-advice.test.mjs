// Tests for lib/git-advice.mjs: the copy-branch C37 advice next to the merge-commit and branch-move ones.
//  - copy branch: `checkout -b`, `switch -c`, `branch`, `worktree add -b` of NAME-<n>|-fix|-fixes|-v<n>|-redo while NAME exists locally.
//  - a fast-forward merge into main gives no advice (the no-PASS advice went with the suite PASS records, checks reset S2).
// Real temporary repos (tests/git-tidy-helpers.mjs).
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { COPY_BRANCH_ADVICE_PATTERN, copyBranchStem, gitAdvice, runGit } from '../home/hooks/lib/git-advice.mjs';
import { MERGE_COMMIT_ADVICE } from '../home/hooks/lib/merge-commit.mjs';
import { BRANCH_MOVE_ADVICE } from '../home/hooks/lib/branch-move.mjs';
import { ADVICE_CLASS, reasonClass } from '../home/hooks/lib/reason-classes.mjs';
import { commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const lane = (repo) => { // a repo on main with a lane branch `lane-x` that exists locally
  git(repo, 'branch', 'lane-x');
  return repo;
};
const matches = (advice, pattern) => advice.length === 1 && pattern.test(advice[0]);

test('copyBranchStem: the existing stem for a -<n>, -fix, -fixes, -v<n> or -redo copy, null otherwise', () => {
  const repo = lane(makeRepo());
  for (const name of ['lane-x-2', 'lane-x-12', 'lane-x-fix', 'lane-x-fixes', 'lane-x-v3', 'lane-x-redo']) assert.equal(copyBranchStem(name, repo), 'lane-x', name);
  for (const name of ['other-2', 'lane-x', 'lane-x-two', 'lane-x-', 'lane-xfix', 'lane-x-v', 'lane-x-2a']) assert.equal(copyBranchStem(name, repo), null, name);
  assert.equal(copyBranchStem('lane-x-2', join(repo, 'no-such-folder')), null, 'a git error is null, never a throw');
});

test('copy branch: each way to create a branch NAME-<n> while NAME exists gets the advice', () => {
  const repo = lane(makeRepo());
  for (const command of [
    'git checkout -b lane-x-2', 'git checkout -B lane-x-fix', 'git switch -c lane-x-v2', 'git switch -C lane-x-redo', 'git switch --create lane-x-fixes',
    'git branch lane-x-3', 'git branch lane-x-3 main', 'git worktree add -b lane-x-2 ../wt', 'git worktree add ../wt -b lane-x-redo',
    'git checkout -b lane-x-2 main', 'git -C . checkout -b lane-x-2', 'git --no-pager branch lane-x-2',
  ]) assert.ok(matches(gitAdvice(command, repo, process.env), COPY_BRANCH_ADVICE_PATTERN), command);
  assert.equal(reasonClass(gitAdvice('git checkout -b lane-x-2', repo)[0]), ADVICE_CLASS.copyBranch);
});

test('copy branch: the folder is the cwd, `git -C dir` or a `cd dir &&` before the command', () => {
  const repo = lane(makeRepo());
  const elsewhere = makeTempDir('git-advice-elsewhere-');
  assert.equal(gitAdvice('git checkout -b lane-x-2', elsewhere).length, 0);
  assert.ok(matches(gitAdvice(`git -C ${repo} checkout -b lane-x-2`, elsewhere), COPY_BRANCH_ADVICE_PATTERN));
  assert.ok(matches(gitAdvice(`cd ${repo} && git checkout -b lane-x-2`, elsewhere), COPY_BRANCH_ADVICE_PATTERN));
});

test('copy branch twin: no advice when the stem is missing, nothing is created, or the text only names the command', () => {
  const repo = lane(makeRepo());
  for (const command of [
    'git checkout -b other-2', 'git checkout lane-x-2', 'git switch lane-x-2', 'git branch -d lane-x-2', 'git branch -D lane-x-2', 'git branch -m lane-x lane-x-2',
    'git branch --list lane-x-2', 'git branch', 'git checkout -b lane-y', 'echo "git checkout -b lane-x-2"', 'git log --grep "checkout -b lane-x-2"',
    'git checkout -b "lane x-2"', 'git checkout -b lane-x-2$(date)', 'git checkout -b $NAME',
  ]) assert.deepEqual(gitAdvice(command, repo, process.env), [], command);
});

test('a fast-forward merge into main gets no advice, whatever the commit has: there is no PASS record any more', () => {
  const repo = lane(makeRepo());
  git(repo, 'checkout', '-q', 'lane-x');
  commit(repo, 'lane.txt');
  git(repo, 'checkout', '-q', 'main');
  for (const command of ['git merge --ff-only lane-x', 'git -C . merge --ff-only lane-x', 'git merge --ff-only -m message lane-x']) assert.deepEqual(gitAdvice(command, repo), [], command);
});

test('the merge-commit and branch-move advices are still given, once each, by the same call', () => {
  const repo = lane(makeRepo());
  assert.deepEqual(gitAdvice('git merge feature', repo), [MERGE_COMMIT_ADVICE]);
  assert.deepEqual(gitAdvice('git update-ref refs/heads/main abc', repo), [BRANCH_MOVE_ADVICE]);
  assert.deepEqual(gitAdvice('git status', repo), []);
});

test('through decide() and the hook: a copy branch is denied once with the advice, the identical retry runs', () => {
  const repo = lane(makeRepo());
  const verdict = decide('git checkout -b lane-x-2', { cwd: repo, project: repo });
  assert.equal(verdict.allow, true);
  assert.ok(matches(verdict.advice, COPY_BRANCH_ADVICE_PATTERN));
  const home = makeTempDir('git-advice-home-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: repo });
  const send = (command) => {
    const input = JSON.stringify({ cwd: repo, session_id: 'sess-1', tool_input: { command } });
    const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    return stdout === '' ? { decision: 'allow' } : JSON.parse(stdout).hookSpecificOutput;
  };
  const first = send('git checkout -b lane-x-2');
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /a re-done lane continues the same branch/);
  assert.deepEqual(send('git checkout -b lane-x-2'), { decision: 'allow' });
});

// Round 4 review of lane G.

test('copy branch: after a cd or pushd the guard cannot read, or with an unknown start folder, there is no advice', () => {
  const repo = lane(makeRepo());
  const copy = 'git checkout -b lane-x-2';
  for (const command of [`cd "$TARGET" && ${copy}`, `pushd /tmp && ${copy}`, `cd - && ${copy}`, `cd ~someone && ${copy}`, `cd sub/$X && ${copy}`]) {
    assert.deepEqual(gitAdvice(command, repo, process.env), [], command);
  }
  assert.deepEqual(gitAdvice(copy, null, process.env), [], 'start folder unknown');
  assert.deepEqual(gitAdvice(`git -C "$X" checkout -b lane-x-2`, repo, process.env), [], 'a -C the guard cannot read');
  assert.ok(matches(gitAdvice(`cd "$TARGET"; cd ${repo} && ${copy}`, repo, process.env), COPY_BRANCH_ADVICE_PATTERN), 'a literal cd afterwards knows the folder again');
});

test('copy branch: git branch listing options are not creating a branch', () => {
  const repo = lane(makeRepo());
  for (const command of ['git branch --merged lane-x-2', 'git branch --contains lane-x-2', 'git branch --no-merged lane-x-2', 'git branch --points-at lane-x-2']) {
    assert.deepEqual(gitAdvice(command, repo, process.env), [], command);
  }
});

test('one time budget for all git calls of a command line: a repository that hangs git costs the line a couple of seconds, not 5 s per reading', (t) => {
  if (process.platform === 'win32') return; // no mkfifo
  const repo = join(makeTempDir('git-advice-fifo-'), 'repo');
  mkdirSync(join(repo, '.git', 'objects'), { recursive: true });
  mkdirSync(join(repo, '.git', 'refs'));
  assert.equal(spawnSync('mkfifo', [join(repo, '.git', 'HEAD')]).status, 0); // a read of HEAD blocks until the time limit
  const command = [1, 2, 3].map((n) => `git -C ${repo} switch -c lane-x-${n}`).join('; ');
  const started = Date.now();
  assert.deepEqual(gitAdvice(command, repo, process.env), []);
  assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
  t.diagnostic('three readings, each would wait the full per-call limit without a shared budget');
});

test('runGit never lets the repository or the caller choose what runs: fsmonitor, hooks, an embedded bare repository, GIT_* variables', () => {
  const repo = makeRepo();
  const marker = join(repo, '..', 'ran');
  const program = join(repo, '..', 'program.sh');
  writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(program, 0o755);
  git(repo, 'config', 'core.fsmonitor', program);
  runGit(repo, ['status', '--porcelain']);
  assert.equal(existsSync(marker), false, 'core.fsmonitor ran a program');

  const hook = join(repo, '.git', 'hooks', 'reference-transaction');
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(hook, 0o755);
  runGit(repo, ['update-ref', 'refs/heads/probe', 'HEAD']);
  assert.equal(existsSync(marker), false, 'a repository hook ran');

  const bare = join(repo, '..', 'bare');
  git(join(repo, '..'), 'init', '-q', '--bare', bare);
  assert.equal(runGit(bare, ['rev-parse', '--git-dir']), null, 'an embedded bare repository was entered');

  const other = makeRepo();
  assert.equal(runGit(repo, ['rev-parse', '--git-dir'], cleanEnv({ GIT_DIR: join(other, '.git') })), '.git', 'GIT_DIR from the caller was used');
  assert.equal(runGit(repo, ['rev-parse', '--git-dir'], process.env, Date.now() - 1), null, 'a passed deadline starts no git');
});
