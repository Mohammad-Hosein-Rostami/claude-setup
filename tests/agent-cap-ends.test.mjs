// Tests for how the main-agent cap of home/hooks/agent-budget.mjs frees and re-dates slots: a full type frees the launches whose
// agent the lead's transcript shows ended after its start (lib/agent-ends.mjs; a queued message that only quotes a notice frees
// nothing, for a launch or a SendMessage resume), the transcript is read only for a full type, the
// stale fallback (STALE_MS, PENDING_MS) still holds, SubagentStart re-dates a running agent and resumes a stopped one, and
// SubagentStop keeps the stopped agent's type (stoppedTypes) for a resume. Each test has a private HOME (the record) and its own
// session id; call counters live in a private TMPDIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { TAIL_BYTES, junkText, noticeContent, noticeLine, writeTranscript } from './agent-ends-notices.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

process.env.TMPDIR = makeTempDir('agent-cap-ends-tmp-'); // the call counters (callCounterPath) go under the temp root of this process
const { claimMainSlot } = await import('../home/hooks/agent-budget.mjs');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(REPO, 'home', 'hooks', 'agent-model-guard.mjs');
const BUDGET = join(REPO, 'home', 'hooks', 'agent-budget.mjs');
const HOOK_TIMEOUT_MS = 5000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEVS = ['agent-a1', 'agent-a2', 'agent-a3'];
const DEAD = 'agent-a2';
const LAUNCHED_AGO_MS = 10 * MINUTE_MS;
const ENDED = ['completed', 'failed', 'killed', 'stopped'];
const HEAD_BYTES = 1024 * 1024; // filler before the last 16 MB, so the transcript is bigger than the tail
const STOPPED_DEV = 'agent-a0';
const CAP_DENY_START = 'agent cap: 3 dev agents of this session run';
/** A queued message that quotes the dead dev's notice after other text: no end (lib/agent-ends.mjs NOTICE_HEADER). */
const quotedNotice = (at) => noticeLine(DEAD, 'failed', at, { content: `the dev said:\n${noticeContent(DEAD, 'failed')}` });
let counter = 0;

function newSession() {
  const home = makeTempDir('agent-cap-ends-home-');
  return { home, env: { HOME: home, USERPROFILE: home }, session: `ends-${process.pid}-${counter++}` };
}
const dirOf = (s) => join(s.home, '.claude', 'state', 'main-agents');
const storeOf = (s) => join(dirOf(s), `${s.session}.json`);
const readStore = (s) => JSON.parse(readFileSync(storeOf(s), 'utf8'));
const seedStore = (s, record) => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
  writeFileSync(storeOf(s), JSON.stringify(record), { mode: 0o600 });
};
/** 3 dev started LAUNCHED_AGO_MS ago (the type is full); returns their launch time. */
function seedThreeDev(s) {
  const at = Date.now() - LAUNCHED_AGO_MS;
  seedStore(s, { launches: DEVS.map((agent, n) => ({ key: `k${n}`, type: 'dev', at, agent })), stopped: [], stoppedTypes: {} });
  return at;
}
const transcriptOf = (lines) => writeTranscript(join(makeTempDir('agent-cap-ends-lead-'), 'lead.jsonl'), lines);
const claimDev = (s, transcriptPath) => claimMainSlot({ session_id: s.session, transcript_path: transcriptPath, tool_input: { subagent_type: 'dev' } }, s.env);
const launchedAgents = (s) => readStore(s).launches.map(({ agent }) => agent);

const hookEnvOf = (s) => hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home, ...agentHomeEnv(s.home), TMPDIR: process.env.TMPDIR });
function spawnHook(script, input, s) {
  const run = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: hookEnvOf(s), timeout: HOOK_TIMEOUT_MS });
  assert.equal(run.error, undefined, 'the hook finished within its timeout');
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
// isolation "worktree" keeps the writer isolation gate out of the cap tests
const guardDev = (s, transcriptPath) => {
  const toolInput = { subagent_type: 'dev', description: 'job', prompt: 'the 4th dev', isolation: 'worktree' };
  const stdout = spawnHook(GUARD, { hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'Agent', transcript_path: transcriptPath, tool_input: toolInput }, s);
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
};
/** Sends a SendMessage to the stopped dev through the guard; null when it printed nothing (the message goes). */
const resumeStoppedDev = (s, transcriptPath) => {
  const toolInput = { to: STOPPED_DEV, message: 'go on' };
  const stdout = spawnHook(GUARD, { hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'SendMessage', transcript_path: transcriptPath, tool_input: toolInput }, s);
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
};
/** 3 dev started LAUNCHED_AGO_MS ago and a stopped dev the record knows the type of; returns their launch time. */
function seedThreeDevAndStopped(s) {
  const at = Date.now() - LAUNCHED_AGO_MS;
  seedStore(s, { launches: DEVS.map((agent, n) => ({ key: `k${n}`, type: 'dev', at, agent })), stopped: [STOPPED_DEV], stoppedTypes: { [STOPPED_DEV]: 'dev' } });
  return at;
}
const budgetEvent = (s, event, agentId, agentType) => assert.equal(spawnHook(BUDGET, { hook_event_name: event, session_id: s.session, agent_id: agentId, agent_type: agentType }, s), '');

// ---- dead agents freed (C1-C5) ----

test('a dev the transcript shows ended after its start frees its slot: the 4th dev runs, and the dead one is stored as a stopped dev', () => {
  for (const status of ENDED) {
    const s = newSession();
    const at = seedThreeDev(s);
    const lead = transcriptOf([noticeLine(DEAD, status, at + 5 * MINUTE_MS)]);
    assert.notEqual(guardDev(s, lead)?.permissionDecision, 'deny', status);
    const record = readStore(s);
    assert.ok(!launchedAgents(s).includes(DEAD), `${status}: the dead dev holds no launch`);
    assert.ok(record.stopped.includes(DEAD), status);
    assert.equal(record.stoppedTypes[DEAD], 'dev', status);
  }
});

test('a notice dated before the launch, a status that is no end, another id or malformed lines free nothing', () => {
  const cases = {
    'dated before the launch': (at) => [noticeLine(DEAD, 'failed', at - 5 * MINUTE_MS)],
    running: (at) => [noticeLine(DEAD, 'running', at + MINUTE_MS)],
    pending: (at) => [noticeLine(DEAD, 'pending', at + MINUTE_MS)],
    'unknown status': (at) => [noticeLine(DEAD, 'paused', at + MINUTE_MS)],
    'another id': (at) => [noticeLine('agent-a9', 'failed', at + MINUTE_MS)],
    malformed: (at) => [
      `{"type":"queue-operation" <task-notification> ${DEAD}`,
      noticeLine(DEAD, 'failed', at + MINUTE_MS, { content: '<task-notification>\n<status>failed</status>\n</task-notification>' }),
      noticeLine(DEAD, 'failed', at + MINUTE_MS, { type: 'user', note: 'queue-operation' }),
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const s = newSession();
    const at = seedThreeDev(s);
    assert.equal(claimDev(s, transcriptOf(lines(at))).state, 'full', name);
    assert.deepEqual(launchedAgents(s), DEVS, `${name}: all 3 still run`);
  }
});

test('a queued message that quotes a dead dev\'s notice frees nothing: the 4th dev launch is denied by the cap and all 3 still run', () => {
  const s = newSession();
  const at = seedThreeDev(s);
  const out = guardDev(s, transcriptOf([quotedNotice(at + MINUTE_MS)]));
  assert.equal(out?.permissionDecision, 'deny', JSON.stringify(out));
  assert.ok(out.permissionDecisionReason.startsWith(CAP_DENY_START), out.permissionDecisionReason);
  assert.deepEqual(launchedAgents(s), DEVS);
});

test('a SendMessage resume of a stopped dev: a quoted notice frees nothing (denied), the real notice frees a slot (it goes)', () => {
  const quoted = newSession();
  const quotedAt = seedThreeDevAndStopped(quoted);
  const out = resumeStoppedDev(quoted, transcriptOf([quotedNotice(quotedAt + MINUTE_MS)]));
  assert.equal(out?.permissionDecision, 'deny', JSON.stringify(out));
  assert.ok(out.permissionDecisionReason.startsWith(CAP_DENY_START), out.permissionDecisionReason);
  const real = newSession();
  const realAt = seedThreeDevAndStopped(real);
  assert.equal(resumeStoppedDev(real, transcriptOf([noticeLine(DEAD, 'failed', realAt + MINUTE_MS)])), null);
});

test('a missing, folder, non-string or nonexistent transcript_path frees nothing, and the cap still denies', () => {
  const folder = makeTempDir('agent-cap-ends-folder-');
  for (const path of [undefined, folder, 42, join(folder, 'none.jsonl')]) {
    const s = newSession();
    seedThreeDev(s);
    assert.equal(claimDev(s, path).state, 'full', JSON.stringify(path));
  }
});

test('a transcript over 16 MB with the notice in its last 16 MB frees the slot; one only before them does not', () => {
  const freed = newSession();
  const at = seedThreeDev(freed);
  const notice = noticeLine(DEAD, 'failed', at + MINUTE_MS);
  const lead = join(makeTempDir('agent-cap-ends-big-'), 'lead.jsonl');
  writeFileSync(lead, `${junkText(TAIL_BYTES + HEAD_BYTES)}${notice}\n`);
  assert.equal(claimDev(freed, lead).state, 'recorded');
  const kept = newSession();
  seedThreeDev(kept);
  writeFileSync(lead, `${notice}\n${junkText(TAIL_BYTES + HEAD_BYTES)}`);
  assert.equal(claimDev(kept, lead).state, 'full');
});

test('a transcript over 16 MB whose last 16 MB start exactly at the notice line frees the slot', () => {
  const s = newSession();
  const at = seedThreeDev(s);
  const notice = `${noticeLine(DEAD, 'failed', at + MINUTE_MS)}\n`;
  const text = junkText(HEAD_BYTES) + notice + junkText(TAIL_BYTES - Buffer.byteLength(notice));
  const lead = join(makeTempDir('agent-cap-ends-edge-'), 'lead.jsonl');
  writeFileSync(lead, text);
  assert.equal(text[Buffer.byteLength(text) - TAIL_BYTES - 1], '\n', 'precondition: the tail starts on a line boundary');
  assert.equal(claimDev(s, lead).state, 'recorded');
});

test('a dev launch while only 2 dev run does not read the transcript: a dev it shows ended keeps its launch', () => {
  const withLead = newSession();
  const without = newSession();
  const at = Date.now() - LAUNCHED_AGO_MS;
  const two = { launches: DEVS.slice(0, 2).map((agent, n) => ({ key: `k${n}`, type: 'dev', at, agent })), stopped: [], stoppedTypes: {} };
  seedStore(withLead, two);
  seedStore(without, two);
  const lead = transcriptOf([noticeLine(DEAD, 'failed', at + MINUTE_MS)]);
  const read = claimDev(withLead, lead);
  const unread = claimDev(without, undefined);
  assert.equal(read.state, 'recorded');
  assert.deepEqual(read.running.map(({ agent }) => agent), unread.running.map(({ agent }) => agent));
  assert.deepEqual([launchedAgents(withLead), readStore(withLead).stopped], [[...DEVS.slice(0, 2), undefined], []]);
});

// ---- the stale fallback (C6) ----

test('a started dev 3 h 5 min old with no tool call no longer counts; one 2 h 50 min old does', () => {
  const now = Date.now();
  const fresh = DEVS.slice(0, 2).map((agent, n) => ({ key: `k${n}`, type: 'dev', at: now - MINUTE_MS, agent }));
  for (const [ago, state] of [[3 * HOUR_MS + 5 * MINUTE_MS, 'recorded'], [2 * HOUR_MS + 50 * MINUTE_MS, 'full']]) {
    const s = newSession();
    seedStore(s, { launches: [...fresh, { key: 'old', type: 'dev', at: now - ago, agent: DEVS[2] }], stopped: [] });
    assert.equal(claimDev(s).state, state, `${ago / MINUTE_MS} min old`);
  }
});

test('a pending dev launch (no agent yet) older than 2 min no longer counts; a younger one does', () => {
  const now = Date.now();
  const fresh = DEVS.slice(0, 2).map((agent, n) => ({ key: `k${n}`, type: 'dev', at: now - MINUTE_MS, agent }));
  for (const [ago, state] of [[3 * MINUTE_MS, 'recorded'], [MINUTE_MS, 'full']]) {
    const s = newSession();
    seedStore(s, { launches: [...fresh, { key: 'pending', type: 'dev', at: now - ago }], stopped: [] });
    assert.equal(claimDev(s).state, state, `${ago / MINUTE_MS} min old`);
  }
});

// ---- SubagentStart and SubagentStop (C7) ----

test('SubagentStart of an agent that already holds a launch re-dates it to now', () => {
  const s = newSession();
  const oldAt = Date.now() - HOUR_MS;
  seedStore(s, { launches: [{ key: 'k0', type: 'dev', at: oldAt, agent: DEVS[0] }], stopped: [], stoppedTypes: {} });
  const before = Date.now();
  budgetEvent(s, 'SubagentStart', DEVS[0], 'dev');
  const [launch] = readStore(s).launches;
  assert.equal(launch.agent, DEVS[0]);
  assert.ok(launch.at >= before, `re-dated: ${launch.at} >= ${before}`);
});

test('SubagentStart of a stopped agent moves it back to the launches and out of stopped and stoppedTypes', () => {
  const s = newSession();
  seedStore(s, { launches: [], stopped: [DEAD, 'agent-lex-0'], stoppedTypes: { [DEAD]: 'dev', 'agent-lex-0': 'lex' } });
  budgetEvent(s, 'SubagentStart', DEAD, 'dev');
  const record = readStore(s);
  assert.deepEqual(record.launches.map(({ type, agent }) => [type, agent]), [['dev', DEAD]]);
  assert.deepEqual(record.stopped, ['agent-lex-0']);
  assert.deepEqual(record.stoppedTypes, { 'agent-lex-0': 'lex' });
});

test('SubagentStop moves the agent to stopped and keeps its type in stoppedTypes', () => {
  const s = newSession();
  seedStore(s, { launches: [{ key: 'k0', type: 'dev', at: Date.now() - MINUTE_MS, agent: DEVS[0] }], stopped: [], stoppedTypes: {} });
  budgetEvent(s, 'SubagentStop', DEVS[0], 'dev');
  assert.deepEqual(readStore(s), { launches: [], stopped: [DEVS[0]], stoppedTypes: { [DEVS[0]]: 'dev' } });
});

test('an old record with no stoppedTypes key still parses, and the next write adds the key', () => {
  const s = newSession();
  seedStore(s, { launches: [], stopped: ['agent-old'] });
  assert.equal(claimDev(s).state, 'recorded');
  assert.deepEqual(readStore(s).stoppedTypes, {});
  assert.deepEqual(readStore(s).stopped, ['agent-old']);
});
