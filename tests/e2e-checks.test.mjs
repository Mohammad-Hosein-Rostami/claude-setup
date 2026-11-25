// Tests of the e2e harness's transcript and log checkers (tests/e2e/lib/checks.mjs, logs.mjs, transcripts.mjs): each checker
// gets a fixture it must pass and its twin it must fail, and E1's own check lines are read off fixture transcripts on disk
// (plan Lane C, C-4: a `sleep 30` and a background shell never stopped each give a FAIL; a clean transcript gives PASS).
// No real `claude` runs: the transcripts are written by tests/e2e-fixtures.mjs into a temp folder.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentCall, bash, briefLine, call, notice, result, say, writeSession } from './e2e-fixtures.mjs';
import {
  backgroundShellsLeft, bossFileCalls, fableModels, LIMITS, longSleeps, reportWords, startsOf, testRunnerCommands, unmetNeeds,
} from './e2e/lib/checks.mjs';
import { dialogCalls, eventsInOrder, guardOutcomes } from './e2e/lib/logs.mjs';
import { loadSession, sessionsInFolder } from './e2e/lib/transcripts.mjs';
import * as E1 from './e2e/scenarios/E1.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = '/work/e2e/repo';
const LONG_SLEEP = 'sleep 30';
const SHORT_SLEEP = 'sleep 2';
const SHELLS_LINE = 'background shells left at a subagent report';
const SLEEPS_LINE = `subagent sleeps of ${LIMITS.longSleepSeconds} s or more`;

test('backgroundShellsLeft: a shell that ended (a notice or TaskStop) before the report is not left; one never stopped is', () => {
  const ended = [...bash('b1', 'npm run dev', { background: true, taskId: 't1' }), notice('t1', 'completed', 5), say('done', 9)];
  const stopped = [...bash('b1', 'npm run dev', { background: true, taskId: 't1' }), call('k1', 'TaskStop', { task_id: 't1' }, 4), say('done', 9)];
  const left = [...bash('b1', 'npm run dev', { background: true, taskId: 't1' }), say('done', 9)];
  const endedAfterReport = [...bash('b1', 'npm run dev', { background: true, taskId: 't1' }), say('done', 3), notice('t1', 'completed', 9)];
  assert.deepEqual(backgroundShellsLeft(ended), []);
  assert.deepEqual(backgroundShellsLeft(stopped), []);
  assert.deepEqual(backgroundShellsLeft(left), ['t1']);
  assert.deepEqual(backgroundShellsLeft(endedAfterReport), ['t1'], 'a shell that ends after the report was still running at it');
});

test('longSleeps: a sleep of 5 s or more counts as polling, in any unit; a shorter one does not', () => {
  assert.deepEqual(longSleeps(bash('s1', SHORT_SLEEP)), []);
  assert.deepEqual(longSleeps(bash('s1', LONG_SLEEP)), [LONG_SLEEP]);
  assert.deepEqual(longSleeps(bash('s1', 'until [ -e f ]; do sleep 1m; done')), ['until [ -e f ]; do sleep 1m; done']);
  assert.deepEqual(longSleeps(bash('s1', 'echo sleep-30')), [], 'a word that only contains sleep is no sleep');
});

test('testRunnerCommands: node --test, npm test, vitest and jest count; other commands do not', () => {
  for (const command of ['node --test tests/a.test.mjs', 'npm test', 'pnpm run test', 'npx vitest run']) {
    assert.deepEqual(testRunnerCommands(bash('r1', command)), [command]);
  }
  assert.deepEqual(testRunnerCommands(bash('r1', 'node --check src/slug.mjs')), []);
});

test('fableModels: a Fable turn, a started Fable agent or Fable usage is found; a denied Fable start and other models are not', () => {
  const clean = { lines: [say('ok', 0, 'claude-opus-5-5'), ...agentCall('a1', { subagent_type: 'lex', model: 'fable' }, { denied: true })], agents: [] };
  assert.deepEqual(fableModels(clean, { modelUsage: { 'claude-opus-5-5': {} } }), []);
  const turn = { lines: [say('ok', 0, 'claude-fable-5-2')], agents: [] };
  assert.deepEqual(fableModels(turn), ['claude-fable-5-2']);
  const started = { lines: agentCall('a1', { subagent_type: 'lex' }, { resolvedModel: 'claude-fable-5-2' }), agents: [] };
  assert.deepEqual(fableModels(started), ['claude-fable-5-2']);
  assert.deepEqual(fableModels({ lines: [], agents: [] }, { modelUsage: { 'claude-fable-5-2': {} } }), ['claude-fable-5-2']);
});

test('reportWords: words before a questions: block count, the block does not', () => {
  const body = Array.from({ length: LIMITS.maxReportWords }, (_, index) => `w${index}`).join(' ');
  assert.equal(reportWords(body), LIMITS.maxReportWords);
  assert.equal(reportWords(`${body}\nquestions:\n- which one? a or b`), LIMITS.maxReportWords);
  assert.equal(reportWords(`${body} one-more`), LIMITS.maxReportWords + 1);
});

test('bossFileCalls: a file tool on a repo file or a search with no path counts; a file outside the repo does not', () => {
  const outside = [call('f1', 'Read', { file_path: '/elsewhere/notes.md' })];
  assert.deepEqual(bossFileCalls(outside, [REPO]), []);
  assert.deepEqual(bossFileCalls([call('f1', 'Read', { file_path: `${REPO}/src/slug.mjs` })], [REPO]), [`Read ${REPO}/src/slug.mjs`]);
  assert.deepEqual(bossFileCalls([call('f1', 'Grep', { pattern: 'slug' })], [REPO]), ['Grep (working folder)']);
  assert.deepEqual(bossFileCalls([call('f1', 'Read', { file_path: `${REPO}-other/a` })], [REPO]), [], 'a sibling folder is not the repo');
});

test('startsOf: a started agent has its id; a denied one has the deny text', () => {
  const [started, denied] = startsOf([
    ...agentCall('a1', { subagent_type: 'lex', prompt: 'p' }, { agentId: 'abc1234' }),
    ...agentCall('a2', { subagent_type: 'lex-web' }, { denied: true, denyText: 'only lex starts lex-web' }),
  ]);
  assert.deepEqual([started.type, started.agentId, started.denied], ['lex', 'abc1234', false]);
  assert.deepEqual([denied.type, denied.denied, denied.denyText], ['lex-web', true, 'only lex starts lex-web']);
});

test('unmetNeeds: a needs: line the boss followed with that agent is met; one it did not follow is unmet', () => {
  const lexAsks = { id: 'l1', type: 'lex', lines: [say('Plan ready.\nneeds: dev to build it, blocks: the build', 10)] };
  const met = { lines: agentCall('a1', { subagent_type: 'dev' }, { seconds: 20 }), agents: [lexAsks] };
  const unmet = { lines: agentCall('a1', { subagent_type: 'tess' }, { seconds: 20 }), agents: [lexAsks] };
  const tooEarly = { lines: agentCall('a1', { subagent_type: 'dev' }, { seconds: 5 }), agents: [lexAsks] };
  assert.deepEqual(unmetNeeds(met), []);
  assert.deepEqual(unmetNeeds(unmet), ['lex: needs dev']);
  assert.deepEqual(unmetNeeds(tooEarly), ['lex: needs dev'], 'a start before the needs: line does not answer it');
});

test('eventsInOrder: the events in order pass (others between, alternatives allowed); a missing or late one fails', () => {
  const order = ['run-started', ['driver-lost', 'run-stopped'], 'resumed', 'run-done'];
  const events = (...kinds) => kinds.map((event) => ({ event }));
  assert.equal(eventsInOrder(events('run-started', 'step-started', 'run-stopped', 'resumed', 'run-done'), order).ok, true);
  assert.deepEqual(eventsInOrder(events('run-started', 'resumed', 'run-done'), order).missing, 'driver-lost or run-stopped');
  assert.equal(eventsInOrder(events('run-started', 'resumed', 'driver-lost', 'run-done'), order).ok, false);
});

test('dialogCalls and guardOutcomes: only dialog calls count (a note does not); only the named sessions are kept', () => {
  const dir = makeTempDir('harness-logs-');
  const dialogLog = join(dir, 'dialog.log');
  writeFileSync(dialogLog, '-e display dialog "Allow git push?" buttons {"Use recommended"}\n-e display notification "done"\n');
  assert.equal(dialogCalls(dialogLog).length, 1);
  assert.deepEqual(dialogCalls(join(dir, 'missing.log')), []);
  const lines = [{ session: 's1', outcome: 'allow' }, { session: 's2', outcome: 'deny' }];
  assert.deepEqual(guardOutcomes(lines, ['s2']), [{ session: 's2', outcome: 'deny' }]);
});

test('loadSession and sessionsInFolder: read a boss transcript and its typed subagents; a missing session is empty', () => {
  const projects = join(makeTempDir('harness-projects-'), 'projects');
  writeSession(projects, REPO, { sessionId: 's1', lines: [say('hi')], agents: [{ id: 'abc', type: 'lex', lines: [say('ok')] }] });
  const session = loadSession(projects, 's1');
  assert.equal(session.lines.length, 1);
  assert.deepEqual(session.agents.map((agent) => [agent.id, agent.type]), [['abc', 'lex']]);
  assert.deepEqual(loadSession(projects, 'nope'), { id: 'nope', key: null, lines: [], agents: [] });
  assert.deepEqual(sessionsInFolder(projects, REPO).map((one) => one.id), ['s1']);
});

/** E1's check lines over one boss session whose dev subagent ran `devLines`; git reads fail (no repo), so only the transcript
 * lines are judged here. */
function e1Lines(devLines) {
  const projects = join(makeTempDir('harness-e1-'), 'projects');
  writeSession(projects, REPO, {
    sessionId: 's1', lines: [briefLine('job'), ...agentCall('a1', { subagent_type: 'dev', prompt: 'build' }, { agentId: 'dev1' })],
    agents: [{ id: 'dev1', type: 'dev', lines: devLines }],
  });
  const ctx = { sessions: [{ name: 'job', sessionId: 's1', dry: false }], paths: { projectsDir: projects }, repo: REPO, dir: '/work/e2e',
    notes: {}, git: () => ({ code: 1, stdout: '', stderr: 'no repo here' }) };
  return Object.fromEntries(E1.check(ctx).map((line) => [line.check, line]));
}

test('C-4: E1 gives a FAIL for a sleep 30 and for a background shell never stopped, and a PASS for each on a clean transcript', () => {
  const dirty = e1Lines([...bash('b1', LONG_SLEEP), ...bash('b2', 'npm run dev', { background: true, taskId: 't9', seconds: 3 }), say('Built.', 9)]);
  assert.equal(dirty[SLEEPS_LINE].pass, false);
  assert.match(dirty[SLEEPS_LINE].observed, /sleep 30/);
  assert.equal(dirty[SHELLS_LINE].pass, false);
  assert.match(dirty[SHELLS_LINE].observed, /t9/);
  const clean = e1Lines([...bash('b1', SHORT_SLEEP), ...bash('b2', 'npm run dev', { background: true, taskId: 't9', seconds: 3 }),
    call('k1', 'TaskStop', { task_id: 't9' }, 6), result('k1', 'stopped', { seconds: 7 }), say('Built.', 9)]);
  assert.equal(clean[SLEEPS_LINE].pass, true);
  assert.equal(clean[SHELLS_LINE].pass, true);
});

test('E1: with no subagent transcript the sleep and shell lines FAIL (empty is not clean)', () => {
  const projects = join(makeTempDir('harness-e1-empty-'), 'projects');
  const ctx = { sessions: [{ name: 'job', sessionId: 'missing', dry: false }], paths: { projectsDir: projects }, repo: REPO, dir: '/work/e2e',
    notes: {}, git: () => ({ code: 1, stdout: '', stderr: '' }) };
  const lines = Object.fromEntries(E1.check(ctx).map((line) => [line.check, line]));
  assert.equal(lines[SLEEPS_LINE].pass, false);
  assert.equal(lines[SHELLS_LINE].pass, false);
});
