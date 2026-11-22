// Tests for home/hooks/git-tidy-gate.mjs: at the end of a turn (Stop), of a subagent (SubagentStop) and before a compaction (PreCompact)
// the setup's git hygiene is checked, so leftovers of a re-done lane, an unlanded lane and an untested base never pile up unseen (C37).
// Every repo is built in a temp folder (git-tidy-helpers.mjs); the hook runs as the real process with a private HOME, except the tests
// that need an outside part (the suite PASS lookup, the check child, a clock): those call `decide` with fakes for just that part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, openLanes } from '../home/hooks/git-tidy-gate.mjs';
import { addWorktree, CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { billAndGinShape, CHECK_TIMEOUT_FOR_TESTS_MS, gateSession, HOUR_MS, inProcessGate, linkStatus, oldLane, SESSION } from './git-tidy-gate-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/git-tidy-gate.mjs', import.meta.url));

test('a repo with nothing to clean passes silently', () => {
  const gate = gateSession();
  assert.equal(gate.stop(makeRepo()), null);
});

test('a re-done lane and agent leftovers block the lead once, with the exact prune line; the same state then passes', () => {
  const gate = gateSession();
  const dir = billAndGinShape();
  const reason = gate.stop(dir);
  assert.match(reason, /superseded-copy lane\/x\b/);
  assert.match(reason, /agent-leftover worktree-agent-aaa/);
  assert.match(reason, /agent-leftover worktree-agent-bbb/);
  assert.match(reason, /git-tidy\.mjs prune .* --apply --include-recent/);
  assert.equal(gate.stop(dir), null, 'block once per state, like commit-gate');
});

test('a changed state blocks again, a continued stop at most twice in a row', () => {
  const gate = gateSession();
  const dir = billAndGinShape();
  assert.ok(gate.stop(dir));
  for (const name of ['aaa', 'bbb', 'ccc']) git(dir, 'branch', `worktree-agent-n${name}`, 'main');
  assert.ok(gate.stop(dir, { stop_hook_active: true }), 'new leftovers are a new state');
  git(dir, 'branch', 'worktree-agent-ddd', 'main');
  assert.ok(gate.stop(dir, { stop_hook_active: true }), 'second block in the chain');
  git(dir, 'branch', 'worktree-agent-eee', 'main');
  assert.equal(gate.stop(dir, { stop_hook_active: true }), null, 'the chain bound lets the third pass, so a stop is never held for long');
});

test('after the leftovers are pruned the state is clean and the stop passes', () => {
  const gate = gateSession();
  const dir = billAndGinShape();
  assert.ok(gate.stop(dir));
  git(dir, 'branch', '-D', 'lane/x', 'worktree-agent-aaa', 'worktree-agent-bbb');
  assert.equal(gate.stop(dir), null);
});

test('a merge commit on the base blocks with the rebase advice, a merged branch with the prune line', () => {
  const gate = gateSession();
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'side.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'main.txt');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const reason = gate.stop(dir);
  assert.match(reason, /merge-commit \S+ "merge side"/);
  assert.match(reason, /rebase/);
  assert.match(reason, /merged-branch side/);
  assert.match(reason, /prune .* --apply --include-recent/);
});

test('a cache hit runs no check', async () => {
  const dir = billAndGinShape();
  const gate = gateSession();
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: dir, GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
  let childRuns = 0;
  const countingCheck = (...args) => {
    childRuns += 1;
    return undefined;
  };
  const input = { hook_event_name: 'Stop', session_id: SESSION, cwd: dir };
  const first = await decide(input, env, {});
  assert.equal(first.block, true);
  const second = await decide(input, env, { runCheck: countingCheck });
  assert.equal(second.block, false);
  assert.equal(childRuns, 0, 'the verdict of the first stop is read from the cache');
  assert.equal(gate.run(input, dir).status, 0, 'the real hook process reads the same cache'); // no wall-time bound: the suite runs files in parallel
});

test('a check that is not done within the timeout passes, and one detached refresh fills the cache for the next stop', async () => {
  const dir = billAndGinShape();
  const gate = gateSession();
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: dir };
  const input = { hook_event_name: 'Stop', session_id: SESSION, cwd: dir };
  assert.deepEqual(await decide(input, env, { checkTimeoutMs: 1 }), { block: false });
  const deadline = Date.now() + 20_000;
  let filled = false;
  while (!filled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cached = await decide(input, env, { runCheck: () => undefined }); // a cache miss would run this fake and so not block
    filled = cached.block === true;
  }
  assert.ok(filled, 'the refresh stored the verdict');
});

test('the check child never runs a program the repository config names (fsmonitor)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/y');
  commit(dir, 'y.txt');
  git(dir, 'checkout', '-q', 'main');
  const worktree = addWorktree(dir, 'wt-y', 'lane/y', { create: false });
  const marker = join(makeTempDir('git-tidy-gate-marker-'), 'ran');
  const program = join(makeTempDir('git-tidy-gate-program-'), 'fsmonitor.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
  chmodSync(program, 0o755);
  git(dir, 'config', 'core.fsmonitor', program);
  git(dir, 'config', 'core.fsmonitor.hookversion', '2');
  git(worktree, 'status', '--porcelain');
  assert.ok(existsSync(marker), 'sanity: plain git runs the program');
  unlinkSync(marker);
  gateSession().stop(dir);
  assert.ok(!existsSync(marker), 'the program did not run during the gate');
});

test('a repository whose own config defines a filter is never checked (git status would run its program)', () => {
  const dir = billAndGinShape();
  git(dir, 'config', 'filter.sneaky.clean', 'cat');
  assert.equal(gateSession().stop(dir), null);
});

// base tip moved this session -------------------------------------------------------------------------------------------------

function transcriptStartedAt(startMs) {
  const path = join(makeTempDir('git-tidy-gate-transcript-'), 'lead.jsonl');
  writeFileSync(path, `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', timestamp: new Date(startMs).toISOString() })}\n`);
  return path;
}

test('a base tip that moved during the session without a suite PASS blocks once and names the command', async () => {
  const dir = makeRepo();
  const tip = git(dir, 'rev-parse', 'main');
  const { stop } = inProcessGate(dir);
  const asked = [];
  const noPass = (repo, rev, options) => {
    asked.push({ rev, options });
    return false;
  };
  const input = { transcript_path: transcriptStartedAt(Date.now() - HOUR_MS) };
  const result = await stop(input, { hasPass: noPass });
  assert.equal(result.block, true);
  assert.match(result.reason, new RegExp(`test-pass run --suite.* at ${tip.slice(0, 8)}`));
  assert.deepEqual(asked[0], { rev: tip, options: { suite: true } });
  assert.deepEqual(await stop(input, { hasPass: noPass }), { block: false }, 'second stop of the same state passes');
});

test('a base tip with a suite PASS, or one that moved before the session began, passes', async () => {
  const dir = makeRepo();
  const withPass = await inProcessGate(dir).stop({ transcript_path: transcriptStartedAt(Date.now() - HOUR_MS) }, { hasPass: () => true });
  assert.deepEqual(withPass, { block: false });
  const before = await inProcessGate(dir).stop({ transcript_path: transcriptStartedAt(Date.now() + HOUR_MS) }, { hasPass: () => false });
  assert.deepEqual(before, { block: false }, 'the tip moved before this session started');
});

test('without a test-pass tool or a transcript the base tip is not judged', async () => {
  const dir = makeRepo();
  assert.deepEqual(await inProcessGate(dir).stop({}, { hasPass: () => false }), { block: false }, 'no transcript: the session start is unknown');
  assert.deepEqual(await inProcessGate(dir).stop({ transcript_path: transcriptStartedAt(Date.now() - HOUR_MS) }, { hasPass: null }), { block: false });
});

// unlanded lanes --------------------------------------------------------------------------------------------------------------

test('an unlanded lane that no open STATUS.md row names blocks once with the land command', () => {
  const gate = gateSession();
  const dir = makeRepo();
  oldLane(dir, 'lane/r4-x');
  linkStatus(gate, dir, [['wip', 'something else entirely']]);
  const reason = gate.stop(dir);
  assert.match(reason, /unlanded-lane\? lane\/r4-x/);
  assert.match(reason, /land-lane\.mjs --branch lane\/r4-x/);
  assert.equal(gate.stop(dir), null);
});

test('an open row that names the branch, or its last path segment, keeps the lane; a done row does not', () => {
  const named = gateSession();
  const dir = makeRepo();
  oldLane(dir, 'lane/r4-x');
  linkStatus(named, dir, [['impl-x', 'lane r4-x: implement it']]);
  assert.equal(named.stop(dir), null, 'the last path segment r4-x is named');

  const done = gateSession();
  const other = makeRepo();
  oldLane(other, 'lane/r4-x');
  linkStatus(done, other, [['impl-x', 'lane r4-x: implement it', true]]);
  assert.match(done.stop(other), /unlanded-lane\? lane\/r4-x/);
});

test('with no STATUS.md linked an unlanded lane is not judged (nothing to name it)', () => {
  const dir = makeRepo();
  oldLane(dir, 'lane/r4-x');
  assert.equal(gateSession().stop(dir), null);
});

// subagents -------------------------------------------------------------------------------------------------------------------

test('a subagent whose own empty worktree-agent branch is left behind is told to delete it, once', () => {
  const gate = gateSession();
  const dir = makeRepo();
  git(dir, 'branch', 'worktree-agent-a1', 'main');
  git(dir, 'branch', 'worktree-agent-a2', 'main');
  const reason = gate.agentStop(dir);
  assert.match(reason, /git branch -d worktree-agent-a1\b/);
  assert.doesNotMatch(reason, /worktree-agent-a2/, 'another agent\'s branch is not this agent\'s to delete');
  assert.equal(gate.agentStop(dir), null);
});

test('a subagent branch with a commit of its own, one still checked out, or no branch at all passes', () => {
  const gate = gateSession();
  const withWork = makeRepo();
  git(withWork, 'checkout', '-q', '-b', 'worktree-agent-a1');
  commit(withWork, 'agent.txt');
  git(withWork, 'checkout', '-q', 'main');
  assert.equal(gate.agentStop(withWork), null);
  git(withWork, 'branch', 'worktree-agent-a2', 'worktree-agent-a1');
  assert.equal(gateSession().agentStop(withWork), null, 'another agent branch at the same commit does not make the work a copy');

  const checkedOut = makeRepo();
  addWorktree(checkedOut, 'wt-agent', 'worktree-agent-a1');
  assert.equal(gateSession().agentStop(checkedOut), null);

  assert.equal(gateSession().agentStop(makeRepo()), null);
});

test('a subagent stop ignores the repository leftovers the lead is told about, and a read-only agent is never blocked', () => {
  const dir = billAndGinShape();
  assert.equal(gateSession().agentStop(dir), null);
  git(dir, 'branch', 'worktree-agent-a1', 'main');
  assert.equal(gateSession().agentStop(dir, { agent_type: 'Explore' }), null);
});

// compaction ------------------------------------------------------------------------------------------------------------------

test('PreCompact prints one line per open lane, and nothing when there is none', () => {
  const gate = gateSession();
  const dir = makeRepo();
  assert.deepEqual(gate.compact(dir), []);
  oldLane(dir, 'lane/one');
  oldLane(dir, 'lane/two');
  const out = gate.compact(dir);
  assert.equal(out.length, 2);
  assert.match(out[0], /open lane lane\/one/);
  assert.match(out[1], /open lane lane\/two/);
});

// failures never trap a session -------------------------------------------------------------------------------------------------

test('outside a git repository, with unusable input or with an unusable event, the hook says nothing and exits 0', () => {
  const gate = gateSession();
  const outside = makeTempDir('git-tidy-gate-plain-');
  assert.equal(gate.stop(outside), null);
  assert.equal(gate.stop(makeRepo(), { session_id: '../escape' }), null);
  const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...CLEAN_ENV, HOME: gate.home } });
  assert.equal(garbage.status, 0);
  assert.match(garbage.stderr, /^git-tidy-gate: /);
  assert.equal(garbage.stdout, '');
});

test('openLanes lists the unmerged branches by name and detail', async () => {
  const dir = makeRepo();
  oldLane(dir, 'lane/one');
  const { env } = inProcessGate(dir);
  const lines = await openLanes({ hook_event_name: 'PreCompact', session_id: SESSION, cwd: dir }, env, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^open lane lane\/one: /);
});
