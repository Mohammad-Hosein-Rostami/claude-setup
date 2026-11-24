// Tests for the resume cap of home/hooks/agent-model-guard.mjs on PreToolUse(SendMessage) (agent-budget.mjs resumeCapReason): a
// message that would resume a stopped lex, dev or tess is denied every time while 3 of its type run, and when the main-agent record
// cannot be read; a message to a running agent, to `main`, or to a name the record holds no type for passes, and no other gate runs.
// Each test has a private HOME (the record, lib/main-agents-store.mjs) and its own session id; the hook runs as a process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

process.env.TMPDIR = makeTempDir('resume-cap-tmp-'); // the call counters (lib/writer-agents.mjs callCounterPath) go under it

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000;
const MINUTE_MS = 60 * 1000;
const RUNNING_DEV = ['agent-dev-1', 'agent-dev-2', 'agent-dev-3'];
const STOPPED_DEV = 'agent-dev-0';
const STOPPED_LEX = 'agent-lex-0';
const LONG_NAME_CHARS = 500;
let counter = 0;

function newSession() {
  const home = makeTempDir('resume-cap-home-');
  return { home, session: `resume-${process.pid}-${counter++}` };
}
const dirOf = (s) => join(s.home, '.claude', 'state', 'main-agents');
const storeOf = (s) => join(dirOf(s), `${s.session}.json`);
const writeStore = (s, text) => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
  writeFileSync(storeOf(s), text, { mode: 0o600 });
};
/** A record with `devs` dev agents started a minute ago (so they run), a stopped dev and a stopped lex. */
function seedRecord(s, { devs = RUNNING_DEV, stoppedTypes = { [STOPPED_DEV]: 'dev', [STOPPED_LEX]: 'lex' } } = {}) {
  const at = Date.now() - MINUTE_MS;
  const launches = devs.map((agent, n) => ({ key: `k${n}`, type: 'dev', at, agent }));
  const record = { launches, stopped: [STOPPED_DEV, STOPPED_LEX], ...(stoppedTypes === null ? {} : { stoppedTypes }) };
  writeStore(s, JSON.stringify(record));
}

/** Sends one SendMessage through the hook; null when it printed nothing (the message goes). */
function send(s, to, extra = {}) {
  const input = { hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'SendMessage', tool_input: { to, message: 'go on' }, ...extra };
  const env = hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home, ...agentHomeEnv(s.home), TMPDIR: process.env.TMPDIR });
  const run = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS });
  assert.equal(run.error, undefined, 'the hook finished within its timeout');
  assert.equal(run.status, 0, run.stderr);
  return run.stdout === '' ? null : JSON.parse(run.stdout).hookSpecificOutput;
}

const resumeCapReason = (s, target) => `agent cap: 3 dev agents of this session run (${RUNNING_DEV.join(', ')}); this message would resume `
  + `${target} as one more; wait for one of them to return, then send it again (store: ${storeOf(s)})`;
const unusableReason = (s) => `agent cap: the main-agent record ${storeOf(s)} cannot be read or stays locked; fix or delete it, then send again`;
const deny = (reason) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason });

test('a message to a stopped dev while 3 dev run is denied every time, naming the cap, the type and the id', () => {
  const s = newSession();
  seedRecord(s);
  for (const attempt of [1, 2]) assert.deepEqual(send(s, STOPPED_DEV), deny(resumeCapReason(s, STOPPED_DEV)), `send ${attempt}`);
  assert.deepEqual(send(s, `${STOPPED_DEV} [ref]`), deny(resumeCapReason(s, STOPPED_DEV)), 'the name with its ref');
});

test('a message to a stopped dev while 2 dev run passes', () => {
  const s = newSession();
  seedRecord(s, { devs: RUNNING_DEV.slice(0, 2) });
  assert.equal(send(s, STOPPED_DEV), null);
});

test('a message to a running dev while 3 dev run passes (no resume)', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, RUNNING_DEV[0]), null);
});

test('main, *, a name the record does not know, empty, non-string and over-long targets pass and leave the store as it is', () => {
  const s = newSession();
  seedRecord(s);
  const before = readFileSync(storeOf(s), 'utf8');
  const mtimeBefore = statSync(storeOf(s)).mtimeMs;
  for (const to of ['main', '*', 'researcher', '', 42, null, { name: STOPPED_DEV }, 'a'.repeat(LONG_NAME_CHARS)]) {
    assert.equal(send(s, to), null, JSON.stringify(to));
  }
  assert.equal(readFileSync(storeOf(s), 'utf8'), before);
  assert.equal(statSync(storeOf(s)).mtimeMs, mtimeBefore);
});

test('a corrupt record does not deny a message to main, *, empty or a non-string target', () => {
  const s = newSession();
  writeStore(s, 'not json');
  for (const to of ['main', '*', '', 42, null, { name: STOPPED_DEV }]) assert.equal(send(s, to), null, JSON.stringify(to));
  assert.equal(readFileSync(storeOf(s), 'utf8'), 'not json', 'the file is left as it is');
});

test('a stopped lex while 3 dev run passes: each type has its own cap', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, STOPPED_LEX), null);
});

test('a stopped id with no recorded type (an old record with no stoppedTypes) passes', () => {
  const s = newSession();
  seedRecord(s, { stoppedTypes: null });
  assert.equal(send(s, STOPPED_DEV), null);
});

test('a corrupt record denies a message to a stopped-looking name with the fail-closed text naming the store', () => {
  const s = newSession();
  writeStore(s, 'not json');
  assert.deepEqual(send(s, STOPPED_DEV), deny(unusableReason(s)));
  assert.equal(readFileSync(storeOf(s), 'utf8'), 'not json', 'the file is left as it is');
});

test('a missing record lets a message to any agent name pass', () => {
  const s = newSession();
  assert.equal(send(s, STOPPED_DEV), null);
  assert.equal(existsSync(storeOf(s)), false, 'no record is made for a message');
});

test('a SendMessage from inside a subagent (agent_id) to main passes', () => {
  const s = newSession();
  seedRecord(s);
  assert.equal(send(s, 'main', { agent_id: RUNNING_DEV[0], agent_type: 'dev' }), null);
});
