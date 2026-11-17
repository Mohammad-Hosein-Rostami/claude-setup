// Tests for home/hooks/git-tidy-gate.mjs when the lead's project folder is not a git repo (a session started in ~): the gate then checks
// the repos of the files the session itself edited (the records of lib/own-edits.mjs) and never a repo the session did not touch.
// Repos are built in temp folders; the hook runs as the real process with a private HOME, except the timeout test, which calls `decide`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, openLanes } from '../home/hooks/git-tidy-gate.mjs';
import { editedWorktrees, worktreeOf } from '../home/hooks/lib/gated-folder.mjs';
import { recordEditedFile } from '../home/hooks/lib/own-edits.mjs';
import { addWorktree, CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { billAndGinShape, CHECK_TIMEOUT_FOR_TESTS_MS, gateSession, oldLane, SESSION } from './git-tidy-gate-helpers.mjs';

const plainFolder = () => mkdtempSync(join(tmpdir(), 'git-tidy-gate-plain-'));

/** Records, as the session's own edit, a file of `repo` (base.txt exists in every repo the helpers build). */
function recordEditIn(gate, repo, agent) {
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home };
  const file = join(repo, 'base.txt');
  assert.equal(recordEditedFile({ session_id: SESSION, ...(agent ? { agent_id: agent } : {}), tool_input: { file_path: file } }, env), true);
}

test('a repo the session edited a file in is gated although the project folder is not a repo; once per state', () => {
  const gate = gateSession();
  const repo = billAndGinShape();
  recordEditIn(gate, repo);
  const reason = gate.stop(plainFolder());
  assert.match(reason, new RegExp(`Git hygiene in ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(reason, /superseded-copy lane\/x\b/);
  assert.match(reason, /git-tidy\.mjs prune .* --apply --include-recent/);
  assert.equal(gate.stop(plainFolder()), null, 'block once per state');
});

test('a repo the session did not edit is never checked, even when it is full of leftovers', () => {
  const gate = gateSession();
  const touched = billAndGinShape();
  const untouched = billAndGinShape();
  assert.equal(gate.stop(plainFolder()), null, 'no edit recorded: nothing is checked');
  recordEditIn(gate, touched);
  const reason = gate.stop(plainFolder());
  assert.ok(reason.includes(touched));
  assert.ok(!reason.includes(untouched), 'only the repo of an edited file is named');
});

test('a clean edited repo passes', () => {
  const gate = gateSession();
  const repo = makeRepo();
  recordEditIn(gate, repo);
  assert.equal(gate.stop(plainFolder()), null);
});

test('an edited repo whose config defines a filter is never judged (git status would run its program)', () => {
  const gate = gateSession();
  const repo = billAndGinShape();
  git(repo, 'config', 'filter.sneaky.clean', 'cat');
  recordEditIn(gate, repo);
  assert.equal(gate.stop(plainFolder()), null);
});

test('the project repo and an edited repo are each blocked once, one after the other', () => {
  const gate = gateSession();
  const project = billAndGinShape();
  const edited = billAndGinShape();
  recordEditIn(gate, edited);
  assert.ok(gate.stop(project).includes(`Git hygiene in ${project}`));
  assert.ok(gate.stop(project).includes(`Git hygiene in ${edited}`));
  assert.equal(gate.stop(project), null);
});

test('a file edited by a subagent counts for the lead too, as in the commit gate', () => {
  const gate = gateSession();
  const repo = billAndGinShape();
  recordEditIn(gate, repo, 'a1');
  assert.ok(gate.stop(plainFolder()).includes(repo));
});

test('a subagent stop is still gated by its own start folder only', () => {
  const gate = gateSession();
  const repo = billAndGinShape();
  recordEditIn(gate, repo, 'a1');
  assert.equal(gate.agentStop(plainFolder()), null);
});

const CLEAN_VERDICT = { base: 'main', findings: [], hints: [] };
const SLOW_CHECK_MS = 600;
const BUDGET_MS = 500;
const posixOnly = { skip: process.platform === 'win32' ? 'no mkfifo on Windows' : false };

/** Makes `Date` a fake clock for this test, so the budget arithmetic does not depend on how long real git calls take on a busy machine. */
const useFakeClock = (t) => t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

/** A runCheck stub that records the time each call was given, takes `takesMs` of the fake clock (`useFakeClock`) and finds nothing. */
function countingCheck(t, takesMs) {
  const timeouts = [];
  const runCheck = (top, timeoutMs) => {
    timeouts.push(timeoutMs);
    t.mock.timers.tick(takesMs);
    return CLEAN_VERDICT;
  };
  return { timeouts, runCheck };
}

/** A gate whose project folder is no repo and which edited a file in each of `repos`; returns the env for decide/openLanes. */
function sessionThatEdited(repos) {
  const gate = gateSession();
  for (const repo of repos) recordEditIn(gate, repo);
  return { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: plainFolder() };
}

test('an edited repo whose check does not finish in time passes instead of holding the stop', async (t) => {
  useFakeClock(t);
  const env = sessionThatEdited([billAndGinShape()]);
  const { timeouts, runCheck } = countingCheck(t, 0);
  assert.deepEqual(await decide({ hook_event_name: 'Stop', session_id: SESSION }, env, { checkTimeoutMs: 1, runCheck: () => 'timeout' }), { block: false });
  await decide({ hook_event_name: 'Stop', session_id: SESSION }, env, { checkTimeoutMs: BUDGET_MS, runCheck });
  assert.equal(timeouts.length, 1, 'the edited repo is checked');
});

test('one stop spends one check budget over all its repos: a second check gets only the time left, or none', async (t) => {
  useFakeClock(t);
  const env = sessionThatEdited([makeRepo(), makeRepo()]);
  const quick = countingCheck(t, 200);
  await decide({ hook_event_name: 'Stop', session_id: SESSION }, env, { checkTimeoutMs: BUDGET_MS, runCheck: quick.runCheck });
  assert.equal(quick.timeouts.length, 2);
  assert.ok(quick.timeouts[1] <= BUDGET_MS - 200, `the second check was given ${quick.timeouts[1]} ms`);
  const slow = countingCheck(t, SLOW_CHECK_MS);
  const envOther = sessionThatEdited([makeRepo(), makeRepo()]);
  await decide({ hook_event_name: 'Stop', session_id: SESSION }, envOther, { checkTimeoutMs: BUDGET_MS, runCheck: slow.runCheck });
  assert.equal(slow.timeouts.length, 1, 'no time left: the second repo is not checked');
});

test('PreCompact keeps to the same budget, so the project lines are not lost to a kill', async (t) => {
  useFakeClock(t);
  const env = sessionThatEdited([makeRepo(), makeRepo()]);
  const slow = countingCheck(t, SLOW_CHECK_MS);
  await openLanes({ hook_event_name: 'PreCompact', session_id: SESSION }, env, { checkTimeoutMs: BUDGET_MS, runCheck: slow.runCheck });
  assert.equal(slow.timeouts.length, 1);
});

test('a lead looks at no more than 5 repos in one stop', async (t) => {
  useFakeClock(t);
  const env = sessionThatEdited(Array.from({ length: 6 }, makeRepo));
  const quick = countingCheck(t, 0);
  await decide({ hook_event_name: 'Stop', session_id: SESSION }, env, { checkTimeoutMs: 60_000, runCheck: quick.runCheck });
  assert.equal(quick.timeouts.length, 5);
});

test('a lane worktree of the project repo is the same repo: blocked once, not once for the checkout and once for the worktree', () => {
  const gate = gateSession();
  const project = billAndGinShape();
  recordEditIn(gate, addWorktree(project, 'lane-wt', 'lane/wt'));
  assert.ok(gate.stop(project).includes(`Git hygiene in ${project}`));
  assert.equal(gate.stop(project), null, 'the worktree adds no second block');
});

test('many worktrees of one repo use one slot: another edited repo is still reached', () => {
  const gate = gateSession();
  const other = makeRepo();
  const crowded = makeRepo();
  recordEditIn(gate, other);
  recordEditIn(gate, crowded);
  for (let n = 1; n <= 5; n += 1) recordEditIn(gate, addWorktree(crowded, `lane-wt-${n}`, `lane/wt-${n}`));
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home };
  const found = editedWorktrees(SESSION, env);
  assert.equal(found.length, 2);
  assert.ok(found.some(({ top }) => top === other), 'the other repo is reached');
});

test('finding the edited repos stops at the deadline, after the first', () => {
  const gate = gateSession();
  for (const repo of [makeRepo(), makeRepo(), makeRepo()]) recordEditIn(gate, repo);
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home };
  assert.equal(editedWorktrees(SESSION, env, { deadlineMs: 0 }).length, 1);
  assert.equal(editedWorktrees(SESSION, env).length, 3);
});

test('a folder whose .git/HEAD never answers (a FIFO) is given up on at once, not waited for', posixOnly, () => {
  const folder = mkdtempSync(join(tmpdir(), 'git-tidy-gate-fifo-'));
  mkdirSync(join(folder, '.git'));
  assert.equal(spawnSync('mkfifo', [join(folder, '.git', 'HEAD')]).status, 0);
  const startedMs = Date.now();
  assert.equal(worktreeOf(folder, 300), null);
  assert.ok(Date.now() - startedMs < 3000);
});

test('PreCompact lists the open lanes of an edited repo too', async () => {
  const gate = gateSession();
  const repo = makeRepo();
  oldLane(repo, 'lane/one');
  recordEditIn(gate, repo);
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: plainFolder(), GIT_TIDY_GATE_CHECK_TIMEOUT_MS: String(CHECK_TIMEOUT_FOR_TESTS_MS) };
  const lines = await openLanes({ hook_event_name: 'PreCompact', session_id: SESSION }, env, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^open lane lane\/one: /);
});
