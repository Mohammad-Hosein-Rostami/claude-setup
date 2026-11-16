// Tests for home/hooks/commit-gate.mjs (Stop and SubagentStop): a stop in a git worktree with uncommitted work is blocked once per dirty
// state, with the reason naming the folder and the file count; the same state stopping again passes, so it never loops. Each test
// builds its own repo in a temp folder (git-tidy-helpers.mjs) and gives the hook a private HOME for its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/commit-gate.mjs';
import { addWorktree, CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { fastestMs } from './timing.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/commit-gate.mjs', import.meta.url));
const SPEED_TARGET_MS = 300;

const dirtyReason = (folder, count) => `Uncommitted changes in ${folder} (${count} files): commit them as small Conventional Commits `
  + '(`git commit -m ... -- <paths>`), or say in your reply why they must stay uncommitted.';
const BASE_SENTENCE = (branch) => ` This is the base folder (${branch}) and lane worktrees exist: edits belong in a lane worktree, never in the base folder.`;

/** A private HOME; stop() sends one Stop (or SubagentStop) event from `cwd` and returns the reason it blocked with, or null. */
function gateSession() {
  const home = mkdtempSync(join(tmpdir(), 'commit-gate-home-'));
  return (cwd, extra = {}) => {
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd, stop_hook_active: false, ...extra });
    const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });
    assert.equal(status, 0, stderr);
    assert.equal(stderr, '');
    if (stdout === '') return null;
    const out = JSON.parse(stdout);
    assert.equal(out.decision, 'block');
    return out.reason;
  };
}

test('a modified tracked file blocks the stop once; the same state passes the second time; a new state blocks again', () => {
  const stop = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(stop(dir), dirtyReason(dir, 1));
  assert.equal(stop(dir), null);
  writeFileSync(join(dir, 'new.txt'), 'untracked');
  assert.equal(stop(dir), dirtyReason(dir, 2));
  assert.equal(stop(dir), null);
});

test('staged and untracked files count; a stop from a subfolder names the worktree; SubagentStop is gated the same way', () => {
  const stop = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'staged.txt'), 's');
  git(dir, 'add', 'staged.txt');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'loose.txt'), 'u');
  assert.equal(stop(join(dir, 'sub'), { hook_event_name: 'SubagentStop', agent_id: 'a1' }), dirtyReason(dir, 2));
});

test('passes: a clean repo, a folder outside git, ignored and .git/info/exclude files, stop_hook_active, an unfinished merge', () => {
  const stop = gateSession();
  const clean = makeRepo();
  assert.equal(stop(clean), null);
  assert.equal(stop(mkdtempSync(join(tmpdir(), 'not-a-repo-'))), null);
  const ignored = makeRepo();
  writeFileSync(join(ignored, '.gitignore'), 'build/\n');
  commit(ignored, '.gitignore', 'build/\n');
  mkdirSync(join(ignored, 'build'));
  writeFileSync(join(ignored, 'build', 'out.js'), 'x');
  writeFileSync(join(ignored, '.git', 'info', 'exclude'), 'STATUS.md\n');
  writeFileSync(join(ignored, 'STATUS.md'), 'notes');
  assert.equal(stop(ignored), null);
  const active = makeRepo();
  writeFileSync(join(active, 'base.txt'), 'changed');
  assert.equal(stop(active, { stop_hook_active: true }), null);
  const merging = makeRepo();
  git(merging, 'checkout', '-q', '-b', 'side');
  commit(merging, 'base.txt', 'side');
  git(merging, 'checkout', '-q', 'main');
  commit(merging, 'base.txt', 'main');
  spawnSync('git', ['merge', 'side'], { cwd: merging, env: CLEAN_ENV }); // conflicts on purpose: the merge stays unfinished
  assert.equal(stop(merging), null);
});

test('the base folder (main) dirty while lane worktrees exist: the reason adds that edits belong in a lane; a dirty lane does not', () => {
  const stop = gateSession();
  const dir = makeRepo();
  writeFileSync(join(dir, 'base.txt'), 'changed');
  assert.equal(stop(dir), dirtyReason(dir, 1), 'no lanes yet: the plain reason');
  const lane = addWorktree(dir, 'wt-lane', 'lane');
  writeFileSync(join(dir, 'other.txt'), 'x');
  assert.equal(stop(dir), dirtyReason(dir, 2) + BASE_SENTENCE('main'));
  writeFileSync(join(lane, 'lane.txt'), 'x');
  assert.equal(stop(lane), dirtyReason(lane, 1));
});

test(`decides in under ${SPEED_TARGET_MS} ms on a dirty repo with a lane`, () => {
  const dir = makeRepo();
  addWorktree(dir, 'wt-lane', 'lane');
  writeFileSync(join(dir, 'base.txt'), 'changed');
  const home = mkdtempSync(join(tmpdir(), 'commit-gate-home-'));
  const fastest = fastestMs(() => decide({ session_id: `s${Math.random().toString(36).slice(2)}`, cwd: dir }, { HOME: home }));
  assert.ok(fastest < SPEED_TARGET_MS, `took ${fastest.toFixed(1)} ms`);
});
