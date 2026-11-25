// Tests of a clone-mode claim killed right after its end-step switch (lib/lane-pool.mjs endFill, lane-slots.mjs fillStateOf): the
// fill file it leaves on a lane already handed out never lets a later claim empty that lane, also while a rebase there has HEAD detached.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, commit, git } from './git-tidy-helpers.mjs';
import { lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the git wrapper that kills the claim is a sh script' };
const SKIP = NEEDS_CLONE.skip || POSIX_ONLY.skip;
const KILLED_BRANCH = 'lane/a';
const NEXT_BRANCH = 'lane/b';
const SHARED_FILE = 'a.txt';
const NOTES_FILE = 'notes.txt';
const NOTES_TEXT = 'untracked notes\n';
const FIRST_SLOT = 1;
const NEXT_SLOT = 2;

const madeFolders = [];
after(() => { for (const folder of madeFolders) removeTempDir(folder); });

/** A temp folder removed by the after hook. */
function tempFolder(label) {
  const folder = makeTempDir(label);
  madeFolders.push(folder);
  return folder;
}

/** A repo of its own with SHARED_FILE committed on main; its temp folder is removed by the after hook. */
function sharedFileRepo() {
  const repo = jsRepo();
  madeFolders.push(dirname(repo));
  commit(repo, SHARED_FILE, 'a\n');
  return repo;
}

/**
 * A folder holding a `git` that runs the real git, then SIGKILLs its parent (the claiming git-tidy) when it was the claim's
 * `switch -c <branch>`: the claim dies between endFill's switch and its fill file's removal, as a crash at that point would.
 */
function killAfterSwitchBin(branch) {
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
  const bin = tempFolder('lane-pool-rebase-bin-');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh\n'${join(execPath, 'git')}' "$@"; status=$?\ncase " $* " in *" -c ${branch} "*) kill -9 $PPID;; esac\nexit $status\n`);
  chmodSync(wrapper, 0o755);
  return bin;
}

/** `lane claim --json` of `branch` at `base`; the spawn result. */
const claimJson = (repo, branch, base, env) => lane(['claim', '--repo', repo, '--branch', branch, '--base', base, '--json'], env);

/** The fill file of pool slot `number` (lane-fill-state.mjs FILL_FOLDER). */
const fillFileOf = (repo, number) => join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'cs-lane-fill', `lane-${number}.json`);

/**
 * The claim of KILLED_BRANCH is killed after its switch; then the worker of that lane commits a change of SHARED_FILE and keeps an
 * untracked NOTES_FILE, while main changes SHARED_FILE too. Returns the repo and the lane's folder.
 */
function laneHandedOutByKilledClaim() {
  const repo = sharedFileRepo();
  const base = git(repo, 'rev-parse', 'HEAD');
  const killed = claimJson(repo, KILLED_BRANCH, base, laneEnv({ pathFirst: [killAfterSwitchBin(KILLED_BRANCH)] }));
  assert.equal(killed.signal, 'SIGKILL', `the claim of ${KILLED_BRANCH} was not killed: ${killed.stdout}${killed.stderr}`);
  const folder = poolPath(repo, FIRST_SLOT);
  assert.equal(git(folder, 'branch', '--show-current'), KILLED_BRANCH, 'the killed claim had switched its folder to the branch');
  assert.ok(existsSync(fillFileOf(repo, FIRST_SLOT)), 'the killed claim left its fill file behind');
  writeFileSync(join(folder, SHARED_FILE), 'lane edit\n');
  git(folder, 'commit', '-q', '-am', 'lane work');
  writeFileSync(join(folder, NOTES_FILE), NOTES_TEXT);
  writeFileSync(join(repo, SHARED_FILE), 'main edit\n');
  git(repo, 'commit', '-q', '-am', 'main moved');
  return { repo, base, folder };
}

/** The next claim, of NEXT_BRANCH in clone mode (CLEAN_ENV holds no GIT_TIDY_LANE_FILL): the lane's notes stay, the claim gets a new slot. */
function assertNextClaimKeepsNotes({ repo, base, folder }) {
  const next = claimJson(repo, NEXT_BRANCH, base, laneEnv());
  const notes = join(folder, NOTES_FILE);
  assert.ok(existsSync(notes), `the claim of ${NEXT_BRANCH} deleted ${KILLED_BRANCH}'s untracked ${NOTES_FILE} in ${folder} (claim output: ${`${next.stdout}${next.stderr}`.trim()})`);
  assert.equal(readFileSync(notes, 'utf8'), NOTES_TEXT);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).folder, poolPath(repo, NEXT_SLOT), `${NEXT_BRANCH} is not given ${KILLED_BRANCH}'s folder`);
}

test("a killed claim's leftover fill file never lets a later claim empty its lane while a rebase there stops on a conflict", { skip: SKIP }, () => {
  const handedOut = laneHandedOutByKilledClaim();
  const rebase = spawnSync('git', ['rebase', 'main'], { cwd: handedOut.folder, encoding: 'utf8', env: CLEAN_ENV });
  assert.notEqual(rebase.status, 0, `the rebase onto main stops on the ${SHARED_FILE} conflict`);
  assert.equal(git(handedOut.folder, 'branch', '--show-current'), '', 'the stopped rebase has HEAD detached');
  writeFileSync(join(handedOut.folder, SHARED_FILE), 'resolved by hand\n'); // the conflict resolution in progress
  assertNextClaimKeepsNotes(handedOut);
});

test("a killed claim's leftover fill file never lets a later claim empty its lane while HEAD stays on the lane's branch", { skip: SKIP }, () => {
  assertNextClaimKeepsNotes(laneHandedOutByKilledClaim());
});
