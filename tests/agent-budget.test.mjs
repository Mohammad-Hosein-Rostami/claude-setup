// Tests for the main-agent cap of home/hooks/agent-budget.mjs, enforced through agent-model-guard.mjs (PreToolUse Agent|Task): at
// most MAX_AGENTS_PER_TYPE (3) lex, 3 dev and 3 tess launched from the main session run at once (a full type blocks no other), helpers (a call with agent_id) never count, a launch
// another gate denies holds no slot, pending launches expire, a started one runs until its SubagentStop (or STALE_MS idle), a
// resumed main agent counts again, and an unusable record denies (fail closed). The route gate: the boss (no agent_id) starts only
// lex, dev, tess, claude-code-guide and statusline-setup; any other type is denied with the route; a subagent starting lex, dev or
// tess is denied with the needs: route, and its own helpers are free. The budget
// hook itself prints nothing.
// Each test has a private HOME (the records) and its own session id; call counters live in a private TMPDIR.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { agentHomeEnv } from './agent-home-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

process.env.TMPDIR = makeTempDir('agent-budget-tmp-'); // the call counters (callCounterPath) go under the temp root of this process
const { MAX_AGENTS_PER_TYPE, PENDING_MS, STALE_MS, claimMainSlot, recordMainStart, recordMainStop, releaseMainSlot } = await import('../home/hooks/agent-budget.mjs');
const { callCounterPath } = await import('../home/hooks/lib/writer-agents.mjs');
const { runningAgentsOf } = await import('../home/hooks/lib/agent-launches.mjs');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(REPO, 'home', 'hooks', 'agent-model-guard.mjs');
const BUDGET = join(REPO, 'home', 'hooks', 'agent-budget.mjs');
const HOOK_TIMEOUT_MS = 5000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
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
  const probe = claim(s, 'lex');
  assert.equal(releaseMainSlot(s.session, probe.key, s.env), true);
  return probe.running.length - 1;
}

// ---- the hooks, spawned the way Claude Code runs them ----

const hookEnvOf = (s) => hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home, ...agentHomeEnv(s.home) });
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

test('the cap is 3 of each main agent type (owner, 2026-11-24)', () => {
  assert.equal(MAX_AGENTS_PER_TYPE, 3);
});

const capReason = (s, type, ids) => `agent cap: 3 ${type} agents of this session run (${ids.join(', ')}); wait for one of them to return; `
  + `the other types have their own 3 (store: ${storeOf(s)})`;

test('the guard runs 3 dev, 3 tess and 3 lex (9 in all) and denies the 4th of a type every time, naming the type and its ids', () => {
  const s = newSession();
  for (const type of ['dev', 'tess', 'lex']) {
    for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.ok(!denied(guard(s, mainCall(`${type}-${n}`, type))), `${type} ${n + 1}`);
  }
  assert.equal(readStore(s).launches.length, 9);
  ['agent-dev-1', 'agent-dev-2'].forEach((id) => assert.equal(budgetEvent(s, 'SubagentStart', id, 'dev'), ''));
  for (const send of [1, 2]) {
    assert.equal(guard(s, mainCall('dev-4', 'dev')).permissionDecisionReason, capReason(s, 'dev', ['agent-dev-1', 'agent-dev-2', 'starting']), `send ${send}`);
  }
  assert.equal(guard(s, mainCall('tess-4', 'tess')).permissionDecisionReason, capReason(s, 'tess', ['starting', 'starting', 'starting']));
  assert.equal(budgetEvent(s, 'SubagentStop', 'agent-dev-1', 'dev'), '');
  assert.ok(!denied(guard(s, mainCall('dev-5', 'dev'))), 'one dev returned: the next dev runs');
  assert.ok(denied(guard(s, mainCall('lex-4', 'lex'))), 'lex is still full');
});

test('a full type blocks no other: 3 dev run, and lex and tess still start', () => {
  const s = newSession();
  for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.ok(!denied(guard(s, mainCall(n, 'dev'))));
  assert.ok(denied(guard(s, mainCall('dev-4', 'dev'))));
  assert.ok(!denied(guard(s, mainCall('lex-1', 'lex'))));
  assert.ok(!denied(guard(s, mainCall('tess-1', 'tess'))));
});

test('helpers are never capped: a call from inside a subagent (agent_id) runs while 3 lex run, and takes no slot', () => {
  const s = newSession();
  for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.ok(!denied(guard(s, mainCall(n))));
  for (const type of ['lex-scout', 'dev-run', 'tess-review', 'lex-web']) {
    assert.ok(!denied(guard(s, mainCall(type, type), { agent_id: 'agent-dev-1', agent_type: 'dev' })), type);
  }
  assert.equal(readStore(s).launches.length, MAX_AGENTS_PER_TYPE);
});

test('the boss\'s Claude Code built-ins (claude-code-guide, statusline-setup) run while 3 lex run, and take no slot', () => {
  const s = newSession();
  for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.ok(!denied(guard(s, mainCall(n))));
  for (const type of ['claude-code-guide', 'statusline-setup']) assert.ok(!denied(guard(s, mainCall(type, type))), type);
  assert.equal(readStore(s).launches.length, MAX_AGENTS_PER_TYPE);
  assert.equal(claim(s, 'claude-code-guide').state, 'helper');
});

test('a call another gate denies holds no slot: the route gate before the cap, the writer gate after it gives the slot back', () => {
  const s = newSession();
  assert.ok(denied(guard(s, { subagent_type: 'dev-pixel', description: 'ui', prompt: 'build the screen' })), 'a helper from the boss');
  assert.equal(existsSync(storeOf(s)), false, 'nothing recorded');
  const plainWriter = (prompt) => ({ subagent_type: 'dev', description: 'build', prompt });
  assert.ok(!denied(guard(s, plainWriter('lane one'))), 'the first writer runs');
  assert.ok(denied(guard(s, plainWriter('lane two'))), 'a second plain writer is denied once by the writer gate');
  assert.equal(readStore(s).launches.length, 1, 'the denied writer gave its slot back');
});

const ROUTE_LEAD = 'agent route: the boss starts lex, dev or tess;';
const helperRoute = (type, owner) => `${ROUTE_LEAD} ${type} is ${owner}'s helper: start ${owner} with the brief, and it starts ${type}`;
const otherRoute = (type) => `${ROUTE_LEAD} ${type} is not one of them: start lex (research, design), dev (build, fix) or tess (checks) with the brief`;

test('the boss starting lex-web is denied every time with the route through lex; nothing is recorded', () => {
  const s = newSession();
  for (let send = 0; send < 2; send += 1) {
    const out = guard(s, mainCall(send, 'lex-web'));
    assert.ok(denied(out), `send ${send}`);
    assert.equal(out.permissionDecisionReason, helperRoute('lex-web', 'lex'));
  }
  assert.equal(existsSync(storeOf(s)), false, 'a route deny takes no main-agent slot');
});

test('every helper from the boss is denied with its own main agent named', () => {
  const owners = { 'lex-scout': 'lex', 'lex-web': 'lex', 'dev-ui': 'dev', 'dev-pixel': 'dev', 'pixel-qa': 'dev', 'dev-debug': 'dev', 'dev-run': 'dev', 'tess-review': 'tess', 'tess-write': 'tess' };
  const s = newSession();
  for (const [type, owner] of Object.entries(owners)) assert.equal(guard(s, mainCall(type, type)).permissionDecisionReason, helperRoute(type, owner), type);
});

test('the boss starts lex, dev and tess, and Claude Code\'s claude-code-guide and statusline-setup', () => {
  const s = newSession();
  for (const type of ['lex', 'dev', 'tess', 'claude-code-guide', 'statusline-setup']) assert.ok(!denied(guard(s, mainCall(type, type))), type);
});

test('the other built-ins, an omitted type and any other agent are denied from the boss', () => {
  const s = newSession();
  for (const type of ['general-purpose', 'Explore', 'Plan', 'claude', 'fork', 'some-plugin:agent', 'security-auditor']) {
    assert.equal(guard(s, mainCall(type, type)).permissionDecisionReason, otherRoute(type), type);
  }
  const { subagent_type: omitted, ...noType } = mainCall('none');
  assert.equal(omitted, 'lex');
  assert.equal(guard(s, noType).permissionDecisionReason, otherRoute('general-purpose'), 'no subagent_type runs general-purpose');
  assert.equal(existsSync(storeOf(s)), false, 'no route deny takes a slot');
});

test('a call from inside a subagent (agent_id) starts lex-web or any other type: helpers are free', () => {
  const s = newSession();
  for (const type of ['lex-web', 'lex-scout', 'general-purpose', 'Explore']) {
    assert.ok(!denied(guard(s, mainCall(type, type), { agent_id: 'agent-lex-1', agent_type: 'lex' })), type);
  }
});

const subagentRoute = (type) => `agent route: only the boss starts lex, dev and tess; ask it with the line 'needs: ${type} to <task>, `
  + 'blocks: <what>\' (SendMessage to main from a background run, else in your report) and go on with what does not depend on it';
// Each main agent and helper of the plan (lex-dev-tess plan, "Helpers it may start") with the helpers it starts
const OWN_HELPERS = {
  lex: ['lex-scout', 'lex-web'], dev: ['dev-ui', 'dev-pixel', 'dev-debug', 'dev-run'], tess: ['tess-review', 'tess-write'],
  'dev-pixel': ['pixel-qa', 'dev-run'], 'dev-ui': ['dev-run'], 'dev-debug': ['lex-scout'],
};

test('a subagent starting lex, dev or tess is denied every time with the needs: route; nothing is recorded', () => {
  const s = newSession();
  for (const from of Object.keys(OWN_HELPERS)) {
    for (const type of ['lex', 'dev', 'tess']) {
      for (let send = 0; send < 2; send += 1) {
        const out = guard(s, mainCall(`${from}-${send}`, type), { agent_id: `agent-${from}-1`, agent_type: from });
        assert.equal(out?.permissionDecisionReason, subagentRoute(type), `${from} -> ${type}, send ${send}`);
      }
    }
  }
  assert.equal(existsSync(storeOf(s)), false, 'a route deny takes no main-agent slot');
});

test('each agent starts its own helpers from inside its run; the boss starts lex', () => {
  const s = newSession();
  for (const [from, helpers] of Object.entries(OWN_HELPERS)) {
    for (const type of helpers) {
      const call = { ...mainCall(type, type), prompt: 'job\nMATRIX: none: a route test, no screen' }; // the MATRIX line keeps the UI gate quiet
      assert.ok(!denied(guard(s, call, { agent_id: `agent-${from}-1`, agent_type: from })), `${from} -> ${type}`);
    }
  }
  assert.ok(!denied(guard(s, mainCall('boss', 'lex'))), 'the boss starts lex');
  assert.equal(readStore(s).launches.length, 1, 'only the boss\'s start takes a main-agent slot');
});

test('a hook input with no usable session id is not capped (no store can be named)', () => {
  const s = newSession();
  for (let n = 0; n <= MAX_AGENTS_PER_TYPE + 1; n += 1) assert.ok(!denied(guard(s, mainCall(n), { session_id: undefined })));
  assert.equal(claimMainSlot({ tool_input: { subagent_type: 'lex' } }, s.env).state, 'unrecorded');
});

test('four lex launches in one message (parallel hook processes) run exactly 3 and deny 1, every round', async () => {
  for (let round = 0; round < 3; round += 1) {
    const s = newSession();
    const outs = await Promise.all(Array.from({ length: MAX_AGENTS_PER_TYPE + 1 }, (_, n) => guardAsync(s, mainCall(n))));
    assert.equal(outs.filter((out) => !denied(out)).length, MAX_AGENTS_PER_TYPE, JSON.stringify(outs));
    assert.equal(readStore(s).launches.length, MAX_AGENTS_PER_TYPE, 'the store holds exactly the 3 recorded, whole');
  }
});

test('a launch that never started stops counting after PENDING_MS; one dated ahead of the clock counts as dated now (H16)', () => {
  const s = newSession();
  const now = Date.now();
  seedStore(s, { launches: [
    { key: 'a', type: 'lex', at: now - PENDING_MS - SECOND_MS },
    { key: 'b', type: 'dev', at: now - PENDING_MS + 30 * SECOND_MS },
    { key: 'c', type: 'tess', at: now + 10 * MINUTE_MS },
  ], stopped: [] });
  assert.equal(running(s), 2, 'the launch of a moment ago may still be starting, and the one dated ahead keeps its slot');
  const redated = readStore(s).launches.find(({ key }) => key === 'c');
  assert.ok(redated.at <= Date.now(), 'stored re-dated to now, so it ages from now');
});

test('H16: the clock moved back 2 h between launches: the 4th dev is still denied, and the store is re-dated', (t) => {
  const s = newSession();
  for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.equal(claim(s, 'dev').state, 'recorded', `launch ${n + 1}`);
  const movedBack = Date.now() - 2 * HOUR_MS;
  t.mock.timers.enable({ apis: ['Date'], now: movedBack });
  const fourth = claim(s, 'dev');
  assert.equal(fourth.state, 'full');
  assert.equal(fourth.running.length, MAX_AGENTS_PER_TYPE);
  assert.ok(readStore(s).launches.every(({ at }) => at === movedBack), 'each launch is stored as dated now');
  t.mock.timers.reset();
});

test('H16: a corrupt main-agent record is unusable: the guard denies, naming it, until it is fixed or deleted', () => {
  const corrupt = ['not json', '[]', 'null', '{"launches": {}}', '{"launches": [{"type": "lex"}]}', '{"launches": [], "stopped": [1]}'];
  for (const text of corrupt) {
    const s = newSession();
    mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
    writeFileSync(storeOf(s), text, { mode: 0o600 });
    assert.equal(claim(s).state, 'unusable', text);
    assert.equal(guard(s, mainCall(1)).permissionDecisionReason,
      `agent cap: the main-agent record ${storeOf(s)} cannot be read or stays locked; fix or delete it, then launch again`, text);
    assert.equal(readFileSync(storeOf(s), 'utf8'), text, 'the file is left as it is');
  }
  const s = newSession();
  seedStore(s, { launches: [] });
  assert.equal(claim(s).state, 'recorded', 'a whole empty record is fine');
});

test('I1: a PostToolUse that lands after the SubagentStop (a late async hook) leaves the agent stopped, and its slot free', () => {
  const s = newSession();
  for (let n = 0; n < MAX_AGENTS_PER_TYPE; n += 1) assert.ok(!denied(guard(s, mainCall(n, 'dev'))), `launch ${n + 1}`);
  assert.equal(budgetEvent(s, 'SubagentStart', 'agent-late-1', 'dev'), '');
  assert.equal(budgetEvent(s, 'PostToolUse', 'agent-late-1', 'dev', { tool_name: 'Bash' }), '');
  assert.equal(budgetEvent(s, 'SubagentStop', 'agent-late-1', 'dev'), '');
  assert.equal(budgetEvent(s, 'PostToolUse', 'agent-late-1', 'dev', { tool_name: 'Bash' }), '', 'the late append');
  assert.equal(existsSync(callCounterPath(s.session, 'agent-late-1')), true, 'the late append made the counter again');
  assert.equal(running(s), MAX_AGENTS_PER_TYPE - 1, 'the stopped agent holds no main-agent slot');
  assert.ok(!runningAgentsOf(s.session, s.env, Date.now()).some(({ agent }) => agent === 'agent-late-1'), 'nor counts as running for the writer gate');
  assert.ok(!denied(guard(s, mainCall('next', 'dev'))), 'the cap freed its slot');
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
    const run = spawnSync(process.execPath, [BUDGET], { input, encoding: 'utf8', env: cleanEnv() });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], input);
  }
});
