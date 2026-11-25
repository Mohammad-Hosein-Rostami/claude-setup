// Repros for land (home/tools/land/land.mjs, its sweep sweep.mjs) and git's built-in fsmonitor daemon (core.fsmonitor=true, macOS
// and Windows). The sweep checks each stale worktree entry (its folder is moved or gone) with `git --git-dir=<entry> diff-index
// --cached HEAD` run from the main checkout (lane-slots.mjs staleIndexWhy through runGit); with fsmonitor on, that call starts a
// daemon whose socket `fsmonitor--daemon.ipc` lands in the entry's admin folder while it watches the main checkout. When the
// moved folder comes back, `git status` in it asks that daemon, sees nothing, and `land` removes the worktree with its
// uncommitted edit.
// Each test fails on the sources it was written for and passes once land's own git calls leave fsmonitor off; it asserts only
// what a person sees afterwards (the entry's folder, land's exit code and refusal, the edit in the file).
// Both tests are skipped where git has no built-in daemon (Linux), decided once at load time. Every daemon a test starts is
// stopped when the test ends, so no process outlives it.
// Each repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { land } from './land-sweep-helpers.mjs';

const DAEMON_SOCKET = 'fsmonitor--daemon.ipc'; // the daemon's socket file; git puts it in the git dir of the checkout that started it
const NOT_SUPPORTED = 'not supported'; // what `git fsmonitor--daemon` says where the daemon is not built in
const EDITED_FILE = 'base.txt'; // tracked in every worktree (makeRepo's one commit)
const EDIT_TEXT = 'uncommitted edit\n';
const REFUSAL = 'changed or untracked file(s)';

/** Runs git in `cwd` and returns the spawn result; no assertion (a stop of a daemon that is not running fails and that is fine). */
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV });

/** True when this git has a built-in fsmonitor daemon (Linux's has none and `status` exits 128 with "not supported"). */
function hasBuiltInDaemon() {
  const probed = gitIn(makeRepo(), ['fsmonitor--daemon', 'status']);
  return !(probed.status === 128 && `${probed.stdout}${probed.stderr}`.includes(NOT_SUPPORTED));
}

const SKIP = hasBuiltInDaemon() ? false : 'git has no built-in fsmonitor daemon on this platform';

/** Stops the daemon of each checkout folder in `folders` and of each admin folder in `gitDirs`; one that is not running is fine. */
function stopDaemons(folders, gitDirs) {
  for (const folder of folders) if (existsSync(folder)) gitIn(folder, ['fsmonitor--daemon', 'stop']);
  for (const gitDir of gitDirs) if (existsSync(gitDir)) gitIn(gitDir, [`--git-dir=${gitDir}`, 'fsmonitor--daemon', 'stop']);
}

/**
 * A repo with core.fsmonitor=true and lanes lane/L and lane/M, each in its own worktree with one commit of a file of its own; the
 * folder of lane/M is moved away, so its entry is stale. Every daemon the setup started is stopped before the move, so the entry
 * holds no socket yet. Registers the cleanup of every daemon the test starts. Returns `{ repo, entry, movedTree, laneTree }`:
 * entry is the admin folder of lane/M, laneTree the folder it came from.
 */
function repoWithMovedLane(t) {
  const repo = makeRepo();
  git(repo, 'config', 'core.fsmonitor', 'true');
  const landedTree = addWorktree(repo, 'wt-L', 'lane/L');
  commit(landedTree, 'l.txt', 'l\n');
  const laneTree = addWorktree(repo, 'wt-M', 'lane/M');
  commit(laneTree, 'm.txt', 'm\n');
  const entry = join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'worktrees', basename(laneTree));
  const movedTree = join(repo, '..', 'wt-M-away');
  t.after(() => stopDaemons([repo, landedTree, laneTree, movedTree], [entry]));
  stopDaemons([repo, landedTree, laneTree], []);
  renameSync(laneTree, movedTree);
  assert.equal(existsSync(join(entry, DAEMON_SOCKET)), false, 'precondition: the stale entry holds no daemon socket yet');
  return { repo, entry, movedTree, laneTree };
}

/** Lands lane/L from `repo`; returns the spawn result and its stdout and stderr in one text for failure messages. */
function landLane(repo, lane) {
  const result = land([lane, '--repo', repo], repo);
  return { result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

// Repro: staleIndexWhy runs git against the entry's admin folder from the main checkout without turning fsmonitor off, so git
// starts a daemon for the main checkout whose socket lands in the stale entry.
test("land's check of a stale entry starts no fsmonitor daemon in that entry", { skip: SKIP }, (t) => {
  const { repo, entry } = repoWithMovedLane(t);
  const { result, said } = landLane(repo, 'lane/L');
  assert.equal(result.status, 0, said);
  assert.equal(existsSync(join(entry, DAEMON_SOCKET)), false, `land started an fsmonitor daemon in the stale entry (${entry}):\n${said}`);
});

// Repro: the consequence. The moved folder comes back, git status in it asks the daemon of the main checkout, sees no change, and
// `land lane/M` removes the worktree with the edit made after it came back.
test("land keeps a returned worktree's uncommitted edit when core.fsmonitor is on", { skip: SKIP }, (t) => {
  const { repo, movedTree, laneTree } = repoWithMovedLane(t);
  const first = landLane(repo, 'lane/L');
  assert.equal(first.result.status, 0, first.said);
  renameSync(movedTree, laneTree);
  git(laneTree, 'status', '--porcelain');
  git(laneTree, 'status', '--porcelain');
  appendFileSync(join(laneTree, EDITED_FILE), EDIT_TEXT);
  const { result, said } = landLane(repo, 'lane/M');
  const kept = existsSync(join(laneTree, EDITED_FILE)) && readFileSync(join(laneTree, EDITED_FILE), 'utf8').includes(EDIT_TEXT);
  assert.equal(kept, true, `the returned worktree's uncommitted edit was lost:\n${said}`);
  assert.equal(result.status, 1, `land lane/M did not refuse:\n${said}`);
  assert.ok(`${result.stdout}${result.stderr}`.includes(REFUSAL), `land lane/M refused for another reason:\n${said}`);
});
