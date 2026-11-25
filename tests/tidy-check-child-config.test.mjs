// Tests for the config the gate's `git-tidy check` child forces (CHILD_GIT_CONFIG in home/hooks/lib/tidy-check-child.mjs): the
// repository's programs never start, whatever GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT the caller passes, and the caller's own
// entries reach the child's git. The child is the real git-tidy on a real repo; its env is the `env` argument. Every repo, HOME
// and hook script is a cs-test temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckChild, runTidyChild } from '../home/hooks/lib/tidy-check-child.mjs';
import { addWorktree, CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { oldLane } from './git-tidy-gate-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CHILD_TIMEOUT_MS = 60_000; // the suite runs test files in parallel; a check must not time out because the machine is busy
const CHECK_OK_STATUSES = [0, 1];
const LANE = 'lane/y';

/** A repo with an old unlanded lane in its own worktree and a `core.fsmonitor` hook (in the repo config) that touches `marker`. */
function repoWithFsmonitorHook() {
  const repo = makeRepo();
  oldLane(repo, LANE);
  addWorktree(repo, 'wt-y', LANE, { create: false });
  const marker = join(makeTempDir('tidy-child-marker-'), 'ran');
  const program = join(makeTempDir('tidy-child-program-'), 'fsmonitor.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
  chmodSync(program, 0o755);
  git(repo, 'config', 'core.fsmonitor', program);
  git(repo, 'config', 'core.fsmonitor.hookversion', '2');
  git(repo, 'status', '--porcelain');
  assert.ok(existsSync(marker), 'sanity: plain git runs the hook');
  unlinkSync(marker);
  return { repo, marker, program };
}

test("the check child never runs the fsmonitor hook that the repository and the caller's GIT_CONFIG_PARAMETERS name", () => {
  const { repo, marker, program } = repoWithFsmonitorHook();
  const verdict = runCheckChild(repo, CHILD_TIMEOUT_MS, { ...CLEAN_ENV, GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${program}'` });
  assert.equal(verdict.hints[0].subject, LANE, 'sanity: the check ran and read the lane');
  assert.ok(!existsSync(marker), 'the hook ran');
});

test("the check child keeps the caller's GIT_CONFIG_COUNT entry (core.excludesFile hides an untracked file from the status it reads)", () => {
  const repo = makeRepo();
  git(repo, 'branch', 'lane/merged');
  const worktree = addWorktree(repo, 'wt-merged', 'lane/merged', { create: false });
  writeFileSync(join(worktree, 'junk.txt'), 'x');
  const excludes = join(makeTempDir('tidy-child-excludes-'), 'excludes');
  writeFileSync(excludes, 'junk.txt\n');
  const hintKinds = (env) => runTidyChild(['check', repo, '--json'], CHILD_TIMEOUT_MS, env, CHECK_OK_STATUSES).hints.map(({ kind }) => kind);
  assert.deepEqual(hintKinds(CLEAN_ENV), ['dirty-worktree?'], 'sanity: without the entry the untracked file counts as a change');
  const caller = { ...CLEAN_ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes };
  assert.deepEqual(hintKinds(caller), ['ignored-files?']);
});

test("the check child never runs the fsmonitor hook when the caller's GIT_CONFIG_COUNT is -1", (t) => {
  const { repo, marker } = repoWithFsmonitorHook();
  t.mock.method(process.stderr, 'write', () => true); // git refuses a count below 0, so the child reports its failure on stderr
  runCheckChild(repo, CHILD_TIMEOUT_MS, { ...CLEAN_ENV, GIT_CONFIG_COUNT: '-1' });
  assert.ok(!existsSync(marker), 'the hook ran');
});
