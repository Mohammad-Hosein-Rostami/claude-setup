// Tests for home/hooks/git-tidy-gate.mjs when the lead's project folder is not a git repo (a session started in ~): the gate then checks
// the repos of the files the session itself edited (the records of lib/own-edits.mjs) and never a repo the session did not touch.
// Repos are built in temp folders; the hook runs as the real process with a private HOME, except the timeout test, which calls `decide`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, openLanes } from '../home/hooks/git-tidy-gate.mjs';
import { recordEditedFile } from '../home/hooks/lib/own-edits.mjs';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { billAndGinShape, gateSession, oldLane, SESSION } from './git-tidy-gate-helpers.mjs';

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

test('an edited repo whose check does not finish in time passes instead of holding the stop', async () => {
  const gate = gateSession();
  const repo = billAndGinShape();
  recordEditIn(gate, repo);
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: plainFolder() };
  assert.deepEqual(await decide({ hook_event_name: 'Stop', session_id: SESSION }, env, { checkTimeoutMs: 1 }), { block: false });
});

test('PreCompact lists the open lanes of an edited repo too', async () => {
  const gate = gateSession();
  const repo = makeRepo();
  oldLane(repo, 'lane/one');
  recordEditIn(gate, repo);
  const env = { ...CLEAN_ENV, HOME: gate.home, USERPROFILE: gate.home, CLAUDE_PROJECT_DIR: plainFolder() };
  const lines = await openLanes({ hook_event_name: 'PreCompact', session_id: SESSION }, env, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^open lane lane\/one: /);
});
