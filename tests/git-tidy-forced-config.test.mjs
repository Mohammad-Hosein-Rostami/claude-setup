// Tests for the config git-tidy forces on every git call (FORCED_CONFIG in home/tools/git-tidy/lib/git.mjs): core.fsmonitor is
// off whatever the caller's GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT say, and the caller's own entries stay. runGit reads
// process.env, so each test runs it in a child whose env is CLEAN_ENV plus the case's own (runGitWith). Every repo, HOME and hook script is a cs-test temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const RUN_GIT_MODULE = pathToFileURL(fileURLToPath(new URL('../home/tools/git-tidy/lib/git.mjs', import.meta.url))).href;
const GIT_FAILED_STATUS = 128; // git's exit code for "unable to parse command-line config"

/**
 * runGit in a child process whose env is CLEAN_ENV plus `extra` (runGit starts from its own process.env, and a test never copies
 * or swaps the session env); returns the `{ status, stdout, stderr }` runGit gave there.
 */
function runGitWith(extra, repo, args) {
  const driver = `import { runGit } from ${JSON.stringify(RUN_GIT_MODULE)};
    const [cwd, args] = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(runGit(cwd, args)));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify([repo, args])], {
    encoding: 'utf8',
    env: { ...CLEAN_ENV, ...extra },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/** A repo whose config names a `core.fsmonitor` hook that touches `marker` when git runs it; `program` is the hook's path. */
function repoWithFsmonitorHook() {
  const repo = makeRepo();
  const marker = join(makeTempDir('git-tidy-forced-marker-'), 'ran');
  const program = join(makeTempDir('git-tidy-forced-program-'), 'fsmonitor.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
  chmodSync(program, 0o755);
  git(repo, 'config', 'core.fsmonitor', program);
  git(repo, 'config', 'core.fsmonitor.hookversion', '2');
  git(repo, 'status', '--porcelain');
  assert.ok(existsSync(marker), 'sanity: plain git runs the hook');
  unlinkSync(marker);
  return { repo, marker, program };
}

test("runGit's core.fsmonitor is false although the caller's GIT_CONFIG_PARAMETERS and the repository say true", () => {
  const repo = makeRepo();
  git(repo, 'config', 'core.fsmonitor', 'true');
  const effective = runGitWith({ GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='true'" }, repo, ['config', '--get', 'core.fsmonitor']);
  assert.deepEqual([effective.status, effective.stdout.trim()], [0, 'false']);
});

test("runGit never runs the fsmonitor hook that the repository and the caller's GIT_CONFIG_PARAMETERS name", () => {
  const { repo, marker, program } = repoWithFsmonitorHook();
  const status = runGitWith({ GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${program}'` }, repo, ['status', '--porcelain']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(!existsSync(marker), 'the hook ran');
});

test("runGit never runs the fsmonitor hook when the caller's GIT_CONFIG_COUNT is -1 (git refuses, nothing is switched back on)", () => {
  const { repo, marker } = repoWithFsmonitorHook();
  const status = runGitWith({ GIT_CONFIG_COUNT: '-1' }, repo, ['status', '--porcelain']);
  assert.equal(status.status, GIT_FAILED_STATUS, 'git fails on a count below 0 instead of ignoring it');
  assert.ok(!existsSync(marker), 'the hook ran');
});

test("runGit keeps the caller's GIT_CONFIG_COUNT entries and GIT_CONFIG_PARAMETERS entries next to the forced core.fsmonitor", () => {
  const repo = makeRepo();
  const caller = {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'A', GIT_CONFIG_KEY_1: 'x.y', GIT_CONFIG_VALUE_1: 'B',
    GIT_CONFIG_PARAMETERS: "'x.z'='C'",
  };
  const seen = ['user.name', 'x.y', 'x.z', 'core.fsmonitor'].map((key) => runGitWith(caller, repo, ['config', '--get', key]).stdout.trim());
  assert.deepEqual(seen, ['A', 'B', 'C', 'false']);
});
