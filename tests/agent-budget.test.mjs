// Tests for the main-agent cap of home/hooks/agent-budget.mjs, enforced through agent-model-guard.mjs (PreToolUse Agent|Task): at
// most MAX_MAIN_AGENTS (6) agents launched from the main session run at once, helpers (a call with agent_id) never count, a launch
// another gate denies holds no slot, pending launches expire, a started one runs until its SubagentStop (or STALE_MS idle), a
// resumed main agent counts again, and an unusable record denies (fail closed). The budget hook itself prints nothing.
// Each test has a private HOME (the records) and its own session id; call counters live in a private TMPDIR.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

process.env.TMPDIR = makeTempDir('agent-budget-tmp-'); // the call counters (callCounterPath) go under the temp root of this process
const { MAX_MAIN_AGENTS, PENDING_MS, STALE_MS, claimMainSlot, recordMainStart, recordMainStop, releaseMainSlot } = await import('../home/hooks/agent-budget.mjs');
const { callCounterPath } = await import('../home/hooks/lib/writer-agents.mjs');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(REPO, 'home', 'hooks', 'agent-model-guard.mjs');
const BUDGET = join(REPO, 'home', 'hooks', 'agent-budget.mjs');
const HOOK_TIMEOUT_MS = 5000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let counter = 0;

/** A private HOME and a session id; `env` is what the lib functions take. */
function newSession() {
  const home = makeTempDir('agent-budget-home-');
  return { home, env: { HOME: home, USERPROFILE: home }, session: `budget-${process.pid}-${counter++}` };
}
const dirOf = (s) => join(s.home, '.claude', 'state', 'main-agents');
const storeOf = (s) => join(dirOf(s), `${s.session}.json`);
const readStore = (s) => JSON.parse(readFileSync(storeOf(s), 'utf8'));
const seedStore = (s, record) => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
  writeFileSync(storeOf(s), JSON.stringify(record), { mode: 0o600 });
};
const claim = (s, type = 'lex', extra = {}) => claimMainSlot({ session_id: s.session, tool_input: { subagent_type: type }, ...extra }, s.env);
/** How many launches hold a slot now: a claim lists every running launch, its own included, and is given back at once. */
function running(s) {
  const probe = claim(s, 'probe');
  assert.equal(releaseMainSlot(s.session, probe.key, s.env), true);
  return probe.running.length - 1;
}

// ---- the hooks, spawned the way Claude Code runs them ----

const hookEnvOf = (s) => hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home });
const guardInput = (s, toolInput, extra = {}) => JSON.stringify({
  hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'Agent', tool_input: toolInput, ...extra,
});
const parseOutput = ({ status, stdout, stderr }) => {
  assert.equal(status, 0, stderr);
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
};
const guard = (s, toolInput, extra) => parseOutput(spawnSync(process.execPath, [GUARD], {
  input: guardInput(s, toolInput, extra), encoding: 'utf8', env: hookEnvOf(s), timeout: HOOK_TIMEOUT_MS,
}));
const guardAsync = (s, toolInput) => new Promise((resolve) => {
  const child = spawn(process.execPath, [GUARD], { env: hookEnvOf(s) });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('close', (status) => resolve(parseOutput({ status, stdout, stderr: '' })));
  child.stdin.end(guardInput(s, toolInput));
});
/** Runs the budget hook for one event; returns its stdout (always '' when it works as it should). */
function budgetEvent(s, event, agentId, agentType, extra = {}) {
  const input = { hook_event_name: event, session_id: s.session, agent_id: agentId, agent_type: agentType, ...extra };
  const run = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(input), encoding: 'utf8', env: { ...hookEnvOf(s), TMPDIR: process.env.TMPDIR } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  return run.stdout;
}
const denied = (out) => out?.permissionDecision === 'deny';
// isolation "worktree" keeps the writer isolation gate out of the cap tests; lex, tess and lex-scout are no writers anyway
const mainCall = (n, type = 'lex') => ({ subagent_type: type, description: 'job', prompt: `job ${n}`, isolation: 'worktree' });
const touchCounter = (session, agent, ms) => {
  const path = callCounterPath(session, agent);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '.');
  utimesSync(path, ms / SECOND_MS, ms / SECOND_MS);
};

test('the cap is 6 main agents', () => {
  assert.equal(MAX_MAIN_AGENTS, 6);
});

test('the guard runs 6 main agents and denies the 7th every time, naming the running types; a stop frees a slot', () => {
  const s = newSession();
  const types = ['lex', 'dev', 'tess', 'lex', 'dev', 'tess'];
  types.forEach((type, n) => assert.ok(!denied(guard(s, mainCall(n, type))), `launch ${n + 1}`));
  const expected = `agent cap: 6 main agents of this session run (${types.join(', ')}); wait for one to return, or let a running agent start `
    + `this one as its helper (store: ${storeOf(s)})`;
  assert.equal(guard(s, mainCall(7)).permissionDecisionReason, expected);
  assert.ok(denied(guard(s, mainCall(7))), 'the identical call sent again is denied too');
  assert.equal(budgetEvent(s, 'SubagentStart', 'agent-lex-1', 'lex'), '');
  assert.ok(denied(guard(s, mainCall(8))), 'a started agent still holds its slot');
  assert.equal(budgetEvent(s, 'SubagentStop', 'agent-lex-1', 'lex'), '');
  assert.ok(!denied(guard(s, mainCall(9))), 'one agent returned: the next launch runs');
});

test('helpers are never capped: a call from inside a subagent (agent_id) runs while 6 main agents run, and takes no slot', () => {
  const s = newSession();
  for (let n = 0; n < MAX_MAIN_AGENTS; n += 1) assert.ok(!denied(guard(s, mainCall(n))));
  for (const type of ['lex-scout', 'dev-run', 'tess-review', 'lex-web']) {
    assert.ok(!denied(guard(s, mainCall(type, type), { agent_id: 'agent-dev-1', agent_type: 'dev' })), type);
  }
  assert.equal(readStore(s).launches.length, MAX_MAIN_AGENTS);
});

test('a call another gate denies holds no slot: the UI gate before the cap, the writer gate after it gives the slot back', () => {
  const s = newSession();
  assert.ok(denied(guard(s, { subagent_type: 'dev-pixel', description: 'ui', prompt: 'build the screen' })), 'no MATRIX line: denied once');
  assert.equal(existsSync(storeOf(s)), false, 'nothing recorded');
  const plainWriter = (prompt) => ({ subagent_type: 'dev', description: 'build', prompt });
  assert.ok(!denied(guard(s, plainWriter('lane one'))), 'the first writer runs');
  assert.ok(denied(guard(s, plainWriter('lane two'))), 'a second plain writer is denied once by the writer gate');
  assert.equal(readStore(s).launches.length, 1, 'the denied writer gave its slot back');
});

test('a hook input with no usable session id is not capped (no store can be named)', () => {
  const s = newSession();
  for (let n = 0; n <= MAX_MAIN_AGENTS + 1; n += 1) assert.ok(!denied(guard(s, mainCall(n), { session_id: undefined })));
  assert.equal(claimMainSlot({ tool_input: { subagent_type: 'lex' } }, s.env).state, 'unrecorded');
});

test('seven launches in one message (parallel hook processes) run exactly 6 and deny 1, every round', async () => {
  for (let round = 0; round < 3; round += 1) {
    const s = newSession();
    const outs = await Promise.all(Array.from({ length: MAX_MAIN_AGENTS + 1 }, (_, n) => guardAsync(s, mainCall(n))));
    assert.equal(outs.filter((out) => !denied(out)).length, MAX_MAIN_AGENTS, JSON.stringify(outs));
    assert.equal(readStore(s).launches.length, MAX_MAIN_AGENTS, 'the store holds exactly the 6 recorded, whole');
  }
});

test('a launch that never started stops counting after PENDING_MS; one dated ahead of the clock never counts', () => {
  const s = newSession();
  const now = Date.now();
  seedStore(s, { launches: [
    { key: 'a', type: 'lex', at: now - PENDING_MS - SECOND_MS },
    { key: 'b', type: 'dev', at: now - PENDING_MS + 30 * SECOND_MS },
    { key: 'c', type: 'tess', at: now + 10 * MINUTE_MS },
  ], stopped: [] });
  assert.equal(running(s), 1, 'only the launch of a moment ago may still be starting');
});

test('a started main agent counts until its stop, or until STALE_MS with no tool call of its own', () => {
  const s = newSession();
  const now = Date.now();
  seedStore(s, { launches: [
    { key: 'a', type: 'dev', at: now - STALE_MS - MINUTE_MS, agent: 'agent-idle' },
    { key: 'b', type: 'dev', at: now - STALE_MS - MINUTE_MS, agent: 'agent-busy' },
    { key: 'c', type: 'lex', at: now - 5 * MINUTE_MS, agent: 'agent-new' },
  ], stopped: [] });
  touchCounter(s.session, 'agent-busy', now - MINUTE_MS);
  assert.equal(running(s), 2, 'the idle one ended unseen; the busy one and the new one run');
});

test('SubagentStart: the oldest pending launch of its type becomes the agent; a helper start changes nothing', () => {
  const s = newSession();
  assert.equal(claim(s, 'dev').state, 'recorded');
  assert.equal(recordMainStart(s.session, 'agent-helper', 'lex-scout', s.env), false, 'no main launch of that type: a helper');
  assert.equal(recordMainStart(s.session, 'agent-dev', 'dev', s.env), true);
  assert.equal(recordMainStart(s.session, 'agent-dev', 'dev', s.env), false, 'a second start of the same agent adds nothing');
  assert.deepEqual(readStore(s).launches.map(({ type, agent }) => [type, agent]), [['dev', 'agent-dev']]);
  assert.equal(recordMainStop(s.session, 'agent-helper', s.env), false, 'a helper stop ends nothing');
});

test('a stopped main agent that starts again (a resume) counts again, and its next stop ends it', () => {
  const s = newSession();
  claim(s, 'lex');
  recordMainStart(s.session, 'agent-lex', 'lex', s.env);
  assert.equal(recordMainStop(s.session, 'agent-lex', s.env), true);
  assert.equal(running(s), 0);
  assert.equal(recordMainStart(s.session, 'agent-lex', 'lex', s.env), true, 'the resume');
  assert.equal(running(s), 1);
  assert.equal(recordMainStop(s.session, 'agent-lex', s.env), true);
  assert.equal(recordMainStop(s.session, 'agent-lex', s.env), false, 'a stop that comes again ends nothing more');
});

test('releaseMainSlot removes only the pending launch with that key', () => {
  const s = newSession();
  const first = claim(s, 'dev');
  const second = claim(s, 'dev');
  recordMainStart(s.session, 'agent-1', 'dev', s.env); // the oldest pending dev launch (the first) is now started
  assert.equal(releaseMainSlot(s.session, first.key, s.env), false, 'a started launch is not released');
  assert.equal(releaseMainSlot(s.session, second.key, s.env), true);
  assert.equal(releaseMainSlot(s.session, second.key, s.env), false);
  assert.equal(readStore(s).launches.length, 1);
});

test('a record that cannot be read gives the fail-closed deny that names it', (t) => {
  if (isRoot) return t.diagnostic('not run: root reads a mode 000 file');
  const s = newSession();
  assert.ok(!denied(guard(s, mainCall(1))));
  chmodSync(storeOf(s), 0);
  assert.equal(guard(s, mainCall(2)).permissionDecisionReason,
    `agent cap: the main-agent record ${storeOf(s)} cannot be read or stays locked; fix or delete it, then launch again`);
  chmodSync(storeOf(s), 0o600);
  assert.ok(!denied(guard(s, mainCall(3))), 'readable again: the launch runs');
});

test('a lock that stays taken is unusable too (fail closed, not "no one runs")', () => {
  const s = newSession();
  claim(s);
  writeFileSync(join(dirOf(s), `${s.session}.lock`), `${process.pid} ${'a'.repeat(32)}`, { flag: 'wx', mode: 0o600 }); // a live holder, fresh lock
  assert.equal(claim(s).state, 'unusable');
});

test('the budget hook prints nothing: a subagent tool call marks its counter, its stop removes it, the main session leaves none', () => {
  const s = newSession();
  const path = callCounterPath(s.session, 'agent-counted');
  assert.equal(budgetEvent(s, 'PostToolUse', 'agent-counted', 'dev', { tool_name: 'Bash' }), '');
  assert.equal(budgetEvent(s, 'PostToolUse', 'agent-counted', 'dev', { tool_name: 'Read' }), '');
  assert.equal(readFileSync(path, 'utf8'), '..');
  assert.equal(budgetEvent(s, 'PostToolUse', undefined, undefined, { tool_name: 'Bash' }), '', 'the main session: no count, no nudge');
  assert.equal(budgetEvent(s, 'PreToolUse', undefined, undefined, { tool_name: 'Bash', tool_input: { command: 'npm test' } }), '');
  assert.equal(budgetEvent(s, 'SubagentStop', 'agent-counted', 'dev', { last_assistant_message: 'x '.repeat(5000), stop_hook_active: false }), '');
  assert.equal(existsSync(path), false, 'the counter goes with the agent; a long report is never sent back');
});

test('the budget hook fails open on bad input', () => {
  for (const input of ['not json', '', '{"hook_event_name":"SubagentStart"}', 'null']) {
    const run = spawnSync(process.execPath, [BUDGET], { input, encoding: 'utf8' });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], input);
  }
});
