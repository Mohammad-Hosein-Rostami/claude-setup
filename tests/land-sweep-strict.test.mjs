// Tests that land's sweep (home/tools/land/sweep.mjs) holds the one rule: only a branch whose content is on the base goes.
// Copies of another branch (an older `-2` copy, an agent's leftover branch) are kept and named under `left:`, while the
// standalone `git-tidy prune --apply` still removes them as main does. A git older than 2.40 (no `merge-tree --stdin`)
// still lands and skips the sweep with one stderr line.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { LAND, branchExists, land, laneSquashedOnTestBranch, outputLines, tipOf } from './land-sweep-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the stand-in git is a shell script' };
const NOT_ON_BASE = 'not all on main; land removes only what is on the base';

/** A repo with lane/c, an older copy of the live lane/c-2, an agent leftover branch whose commit is on lane/c-2, and lane/l. */
function repoWithCopies() {
  const repo = makeRepo();
  const copyTree = addWorktree(repo, 'copy', 'lane/c-2');
  const copyTip = commit(copyTree, 'c.txt');
  git(repo, 'branch', 'lane/c', copyTip);
  git(repo, 'branch', 'worktree-agent-abc', copyTip);
  commit(copyTree, 'c-more.txt');
  git(repo, 'worktree', 'remove', copyTree);
  commit(addWorktree(repo, 'lane', 'lane/l'), 'lane.txt');
  return { repo, copyTip };
}

test('copies whose work is on another branch, not on the base, are kept by the sweep and named under left:', () => {
  const { repo, copyTip } = repoWithCopies();
  const result = land(['lane/l', '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  const agentWhy = `its commits are on other branches, ${NOT_ON_BASE}`;
  const copyWhy = `its work is in lane/c-2, ${NOT_ON_BASE}`;
  assert.deepEqual(outputLines(result.stdout).slice(3), [
    `kept worktree-agent-abc: ${agentWhy}`,
    `kept lane/c: ${copyWhy}`,
    'left:',
    `  lane/c: kept: ${copyWhy}`,
    '  lane/c-2: active, ahead 2',
    `  worktree-agent-abc: kept: ${agentWhy}`,
  ]);
  assert.deepEqual([tipOf(repo, 'lane/c'), tipOf(repo, 'worktree-agent-abc')], [copyTip, copyTip]);
});

// Guard: the standalone prune a person runs by hand keeps main's copy rule (it shares the code, with onlyOnBase off).
test('the standalone git-tidy prune --apply still removes those copies, as main does', () => {
  const { repo } = repoWithCopies();
  const pruned = tidy(['prune', repo, '--apply'], { cwd: repo });
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.deepEqual([branchExists(repo, 'lane/c'), branchExists(repo, 'worktree-agent-abc'), branchExists(repo, 'lane/c-2')], [false, false, true]);
});

/** A folder holding a stand-in `git` that says it is 2.39.5 and passes every other command to the real git. */
function oldGitFolder() {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  assert.notEqual(realGit, '', 'precondition: git is on PATH');
  const folder = makeTempDir('old-git-');
  const script = join(folder, 'git');
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = version ]; then echo 'git version 2.39.5'; exit 0; fi\nexec '${realGit}' "$@"\n`);
  chmodSync(script, 0o755);
  return folder;
}

test('with a git older than 2.40 land still lands, skips the sweep with one stderr line and deletes nothing else', POSIX_ONLY, () => {
  const { repo, laneTip, testTip } = laneSquashedOnTestBranch();
  const env = { ...CLEAN_ENV, PATH: `${oldGitFolder()}${delimiter}${CLEAN_ENV.PATH ?? ''}` };
  const result = spawnSync(process.execPath, [LAND, 'test/x', '--repo', repo], { cwd: repo, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^land: test\/x landed on main at [0-9a-f]+ and was removed; the clean-up of other branches was skipped: git version 2\.39\.5 is older than 2\.40, which the content proof needs \(git merge-tree --stdin\)\n$/);
  assert.equal(tipOf(repo, 'main'), testTip);
  assert.equal(branchExists(repo, 'test/x'), false);
  assert.equal(tipOf(repo, 'lane/x'), laneTip, 'the content-equal lane stays: no sweep ran');
});
