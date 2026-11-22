// Tests for the agent cap (lane agent-cap, plan "no workflows" C7/C9): at most MAX_RUNNING_AGENTS (5) agents of any kind run at once per
// session, enforced by the PreToolUse(Agent|Task) hook (home/hooks/agent-model-guard.mjs) over the launch record
// home/hooks/lib/agent-launches.mjs keeps; the settings turn workflows off and set the CLI's own env cap as a backstop (equal to the
// hook's number); scripts/doctor.sh `check_agent_cap` fails when the live settings drift from that.
// Each test has a private HOME (the launch record) and its own session id; call counters live in a private TMPDIR.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

process.env.TMPDIR = makeTempDir('agent-cap-tmp-'); // the call counters (callCounterPath) go under the temp root of this process
import { IDLE_MS, MAX_RUNNING_AGENTS, PENDING_MS, recordAgentLaunch, recordAgentStart, recordAgentStop, runningAgentsOf } from '../home/hooks/lib/agent-launches.mjs';
import { callCounterPath } from '../home/hooks/lib/writer-agents.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(REPO, 'home', 'hooks', 'agent-model-guard.mjs');
const BUDGET = join(REPO, 'home', 'hooks', 'agent-budget.mjs');
const DOCTOR = join(REPO, 'scripts', 'doctor.sh');
const HOOK_TIMEOUT_MS = 5000;
const SECOND_MS = 1000;
const PAUSE_MS = 25; // so a file's mtime is later than a time read just before (resume tests)
const PARALLEL_LAUNCHES = 6;
const hasJq = spawnSync('jq', ['--version']).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let counter = 0;

/** A private HOME and a session id; `env` is what the lib functions take. */
function newSession() {
  const home = makeTempDir('agent-cap-home-');
  return { home, env: { HOME: home, USERPROFILE: home }, session: `cap-${process.pid}-${counter++}` };
}

const dirOf = (s) => join(s.home, '.claude', 'state', 'agent-writers');
const storeOf = (s) => join(dirOf(s), `${s.session}.json`);
const readStore = (s) => JSON.parse(readFileSync(storeOf(s), 'utf8'));
const seedStore = (s, record) => {
  mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
  writeFileSync(storeOf(s), JSON.stringify(record), { mode: 0o600 });
};
const launch = (s, type = 'scout', options = {}) => recordAgentLaunch(s.session, type, s.env, { cap: MAX_RUNNING_AGENTS, ...options });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const touchCounter = (s, agent, ms) => {
  const path = callCounterPath(s.session, agent);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '.');
  utimesSync(path, ms / SECOND_MS, ms / SECOND_MS);
};

// ---- the hook, spawned the way Claude Code runs it ----

function hookInput(s, toolInput, extra = {}) {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: s.session, cwd: s.home, tool_name: 'Agent', tool_input: toolInput, ...extra });
}
const guardEnv = (s) => hookEnv({ HOME: s.home, USERPROFILE: s.home, CLAUDE_PROJECT_DIR: s.home });
const parseOutput = ({ status, stdout, stderr }) => {
  assert.equal(status, 0, stderr);
  return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
};
const guard = (s, toolInput, extra) => parseOutput(spawnSync(process.execPath, [GUARD], { input: hookInput(s, toolInput, extra), encoding: 'utf8', env: guardEnv(s), timeout: HOOK_TIMEOUT_MS }));
const guardAsync = (s, toolInput) => new Promise((resolve) => {
  const child = spawn(process.execPath, [GUARD], { env: guardEnv(s) });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('close', (status) => resolve(parseOutput({ status, stdout, stderr: '' })));
  child.stdin.end(hookInput(s, toolInput));
});
const budgetEvent = (s, event, agentId, agentType) => {
  const input = { hook_event_name: event, session_id: s.session, agent_id: agentId, agent_type: agentType, last_assistant_message: 'done', stop_hook_active: false };
  const { status, stderr } = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(input), encoding: 'utf8', env: guardEnv(s) });
  assert.equal(status, 0, stderr);
};
const denied = (out) => out?.permissionDecision === 'deny';
const scoutCall = (n) => ({ subagent_type: 'scout', description: 'look', prompt: `job ${n}` });

// ---- acceptance: the 6th launch ----

test('MAX_RUNNING_AGENTS is 5', () => {
  assert.equal(MAX_RUNNING_AGENTS, 5);
});

test('the 6th recorded launch returns full with 5 running entries and records nothing', () => {
  const s = newSession();
  for (let n = 0; n < MAX_RUNNING_AGENTS; n += 1) assert.equal(launch(s).state, 'recorded');
  const sixth = launch(s, 'reviewer');
  assert.equal(sixth.state, 'full');
  assert.equal(sixth.running.length, 5);
  assert.ok(sixth.running.every((entry) => entry.type === 'scout' && Number.isFinite(entry.at)));
  assert.equal(sixth.storePath, storeOf(s));
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 5);
});

test('the hook denies the 6th agent every time with the cap text that lists the running ones; a stop frees a slot', () => {
  const s = newSession();
  for (let n = 0; n < MAX_RUNNING_AGENTS; n += 1) assert.ok(!denied(guard(s, scoutCall(n))), `launch ${n + 1}`);
  const expected = `agent cap: 5 agents of this session run (${Array(5).fill('scout pending').join(', ')}); wait for one to return (store: ${storeOf(s)})`;
  assert.equal(guard(s, scoutCall(6)).permissionDecisionReason, expected);
  assert.ok(denied(guard(s, scoutCall(6))), 'the identical call sent again is denied too');
  budgetEvent(s, 'SubagentStart', 'agentaaaa-1111', 'scout');
  assert.match(guard(s, scoutCall(7)).permissionDecisionReason, /\(scout agentaaa, scout pending/);
  budgetEvent(s, 'SubagentStop', 'agentaaaa-1111', 'scout');
  assert.ok(!denied(guard(s, scoutCall(8))), 'one agent returned: the next launch runs');
});

test('every kind counts: writers, isolated writers and read-only agents share the 5 slots', () => {
  const s = newSession();
  const calls = [
    { subagent_type: 'implementer', prompt: 'one' },
    { subagent_type: 'implementer', prompt: 'two', isolation: 'worktree' },
    { subagent_type: 'reviewer', prompt: 'three' },
    { subagent_type: 'Explore', prompt: 'four' },
    { subagent_type: 'some-plugin:helper', prompt: 'five' },
  ];
  for (const call of calls) assert.ok(!denied(guard(s, call)), call.subagent_type);
  assert.match(guard(s, { subagent_type: 'runner', prompt: 'six' }).permissionDecisionReason, /^agent cap: 5 agents of this session run \(implementer pending, implementer pending, reviewer pending/);
  assert.ok(denied(guard(s, { subagent_type: 'implementer', prompt: 'seven', isolation: 'worktree' })));
});

test('a call that another gate of the hook denies holds no slot', () => {
  const s = newSession();
  assert.ok(denied(guard(s, { subagent_type: 'ui-implementer', description: 'ui', prompt: 'build the screen' })), 'a UI brief with no MATRIX line is denied once');
  assert.deepEqual(runningAgentsOf(s.session, s.env, Date.now()), []);
});

test('a hook input with no usable session id is not capped (no store can be named)', () => {
  const s = newSession();
  for (let n = 0; n < PARALLEL_LAUNCHES; n += 1) assert.ok(!denied(guard(s, scoutCall(n), { session_id: undefined })));
});

// ---- fail closed (P3, OD-6) ----

test('a launch record that cannot be read gives the fail-closed deny that names it', (t) => {
  if (isRoot) return t.diagnostic('not run: root reads a mode 000 file');
  const s = newSession();
  assert.ok(!denied(guard(s, scoutCall(1))));
  chmodSync(storeOf(s), 0);
  const out = guard(s, scoutCall(2));
  assert.equal(out.permissionDecisionReason, `agent cap: the launch record ${storeOf(s)} cannot be read or stays locked; fix or delete it, then launch again`);
  assert.equal(launch(s).state, 'unusable');
  chmodSync(storeOf(s), 0o600);
  assert.ok(!denied(guard(s, scoutCall(3))), 'readable again: the launch runs');
});

test('a lock that stays taken is unusable too (fail closed, not "no one runs")', () => {
  const s = newSession();
  launch(s);
  writeFileSync(join(dirOf(s), `${s.session}.lock`), `${process.pid} ${'a'.repeat(32)}`, { flag: 'wx', mode: 0o600 }); // a live holder, fresh lock
  const result = launch(s);
  assert.equal(result.state, 'unusable');
  assert.deepEqual(result.running, []);
  assert.equal(result.storePath, storeOf(s));
});

// ---- F1 two at once ----

test('F1: six launches in one message (parallel hook processes) record exactly 5 and deny 1, every round', async () => {
  for (let round = 0; round < 3; round += 1) {
    const s = newSession();
    const outs = await Promise.all(Array.from({ length: PARALLEL_LAUNCHES }, (_, n) => guardAsync(s, scoutCall(n))));
    assert.equal(outs.filter((out) => !denied(out)).length, MAX_RUNNING_AGENTS, JSON.stringify(outs));
    assert.equal(outs.filter(denied).length, 1);
    assert.equal(readStore(s).launches.length, MAX_RUNNING_AGENTS, 'the store holds exactly the 5 recorded, whole');
  }
});

// ---- F2 stale ----

test('F2: a launch that never started stops counting after PENDING_MS', () => {
  const s = newSession();
  const { running } = launch(s);
  const at = running[0].at;
  assert.equal(runningAgentsOf(s.session, s.env, at + PENDING_MS - SECOND_MS).length, 1);
  assert.equal(runningAgentsOf(s.session, s.env, at + PENDING_MS + SECOND_MS).length, 0);
});

test('F2: an agent with no SubagentStop stops counting after IDLE_MS since its start or last tool call', () => {
  const s = newSession();
  launch(s);
  assert.equal(recordAgentStart(s.session, 'agent-idle-1', 'scout', s.env), true);
  const { launches } = readStore(s);
  const started = launches[0].at;
  assert.equal(runningAgentsOf(s.session, s.env, started + IDLE_MS - SECOND_MS).length, 1);
  assert.equal(runningAgentsOf(s.session, s.env, started + IDLE_MS + SECOND_MS).length, 0);
  const lastCall = started + 20 * 60 * SECOND_MS;
  touchCounter(s, 'agent-idle-1', lastCall);
  assert.equal(runningAgentsOf(s.session, s.env, lastCall + IDLE_MS - SECOND_MS).length, 1, 'a tool call keeps it counted');
  assert.equal(runningAgentsOf(s.session, s.env, lastCall + IDLE_MS + SECOND_MS).length, 0);
});

test('F2: a launch dated ahead of the clock never counts', () => {
  const s = newSession();
  seedStore(s, { launches: [{ type: 'scout', at: Date.now() + 10 * 60 * SECOND_MS }] });
  assert.deepEqual(runningAgentsOf(s.session, s.env, Date.now()), []);
});

// ---- F3 resume (U3) ----

test('F3: a stopped agent that makes a tool call counts again; one whose counter is older than its stop does not', () => {
  const s = newSession();
  launch(s, 'reviewer');
  recordAgentStart(s.session, 'agent-resume-1', 'reviewer', s.env);
  assert.equal(recordAgentStop(s.session, 'agent-resume-1', 'reviewer', s.env), true);
  assert.deepEqual(runningAgentsOf(s.session, s.env, Date.now()), [], 'stopped, no tool call since');
  const stoppedAt = readStore(s).stoppedAt['agent-resume-1'];
  assert.equal(typeof stoppedAt, 'number');
  touchCounter(s, 'agent-resume-1', stoppedAt - 5 * SECOND_MS);
  assert.deepEqual(runningAgentsOf(s.session, s.env, stoppedAt + SECOND_MS), [], 'a counter older than the stop is the agent before its stop');
  touchCounter(s, 'agent-resume-1', stoppedAt + 5 * SECOND_MS);
  const resumed = runningAgentsOf(s.session, s.env, stoppedAt + 10 * SECOND_MS);
  assert.deepEqual(resumed.map(({ type, agent }) => ({ type, agent })), [{ type: 'reviewer', agent: 'agent-resume-1' }]);
  assert.deepEqual(runningAgentsOf(s.session, s.env, stoppedAt + 5 * SECOND_MS + IDLE_MS + SECOND_MS), [], 'idle again after IDLE_MS');
});

test('F3: a resumed agent takes a cap slot, and its next stop ends it again', async () => {
  const s = newSession();
  launch(s);
  recordAgentStart(s.session, 'agent-resume-2', 'scout', s.env);
  recordAgentStop(s.session, 'agent-resume-2', 'scout', s.env);
  for (let n = 0; n < MAX_RUNNING_AGENTS - 1; n += 1) launch(s);
  await sleep(PAUSE_MS);
  touchCounter(s, 'agent-resume-2', Date.now());
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 5);
  assert.equal(launch(s).state, 'full');
  await sleep(PAUSE_MS);
  assert.equal(recordAgentStop(s.session, 'agent-resume-2', 'scout', s.env), true, 'the second stop of a resumed agent counts');
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 4);
  assert.equal(recordAgentStop(s.session, 'agent-resume-2', 'scout', s.env), false, 'a stop that comes again ends nothing more');
});

test('F3: a SubagentStart of a stopped agent (a resume that fires it) counts once, not twice', () => {
  const s = newSession();
  launch(s);
  recordAgentStart(s.session, 'agent-resume-3', 'scout', s.env);
  recordAgentStop(s.session, 'agent-resume-3', 'scout', s.env);
  recordAgentStart(s.session, 'agent-resume-3', 'scout', s.env);
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 1);
  assert.equal(recordAgentStop(s.session, 'agent-resume-3', 'scout', s.env), true);
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 0);
});

// ---- F4 upgrade and U4 ----

test('F4: an old store whose launches lack `writer` still reads, each counting as a writer', () => {
  const s = newSession();
  seedStore(s, { launches: [{ type: 'implementer', at: Date.now() }, { type: 'scout', at: Date.now(), writer: false }], stopped: ['old-agent'] });
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 2);
  assert.equal(launch(s, 'implementer', { writer: true, unlessRunning: true }).state, 'running', 'the old launch is a plain writer');
  seedStore(s, { launches: [{ type: 'scout', at: Date.now(), writer: false }, { type: 'implementer', at: Date.now(), isolated: true }] });
  assert.equal(launch(s, 'implementer', { writer: true, unlessRunning: true }).state, 'recorded', 'read-only and isolated launches are no plain writer');
});

test('U4: a SubagentStart with no launch of its type is recorded unmatched: it counts for the cap, never for writer isolation', () => {
  const s = newSession();
  assert.equal(recordAgentStart(s.session, 'agent-fork-1', 'fork', s.env), true);
  const { launches } = readStore(s);
  assert.equal(launches.length, 1);
  assert.deepEqual({ type: launches[0].type, agent: launches[0].agent, unmatched: launches[0].unmatched }, { type: 'fork', agent: 'agent-fork-1', unmatched: true });
  assert.equal(runningAgentsOf(s.session, s.env, Date.now()).length, 1);
  assert.equal(launch(s, 'implementer', { writer: true, unlessRunning: true }).state, 'recorded', 'no isolation advice for an unmatched agent');
  assert.equal(recordAgentLaunch(s.session, 'scout', s.env, { cap: 2 }).state, 'full', 'but 2 running fill a cap of 2');
});

test('a start that matches a pending launch of its type marks it started and adds nothing', () => {
  const s = newSession();
  launch(s, 'implementer', { writer: true });
  recordAgentStart(s.session, 'agent-match-1', 'implementer', s.env);
  const { launches } = readStore(s);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].agent, 'agent-match-1');
  assert.equal(launches[0].unmatched, undefined);
  assert.equal(launches[0].writer, true);
});

// ---- F5 crash ----

test('F5: a temp file a killed hook left and a stale lock of a dead process do not stop the next launch, and the record is whole', () => {
  const s = newSession();
  launch(s);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const lock = join(dirOf(s), `${s.session}.lock`);
  writeFileSync(lock, `${dead} ${'b'.repeat(32)}`, { mode: 0o600 });
  const old = (Date.now() - 10 * SECOND_MS) / SECOND_MS;
  utimesSync(lock, old, old);
  writeFileSync(join(dirOf(s), `${s.session}.json.deadbeef.tmp`), '{"launches": [{"ty', { mode: 0o600 });
  assert.equal(launch(s).state, 'recorded');
  assert.equal(readStore(s).launches.length, 2, 'the whole record of the first launch was read, then written whole');
  assert.equal(existsSync(lock), false, 'the stale lock was taken over and released');
});

test('a store with many long open records is trimmed, never grown past what the next read accepts', () => {
  const s = newSession();
  const about = { cwd: `/work/${'x'.repeat(900)}`, description: 'd'.repeat(200) };
  for (let n = 0; n < 60; n += 1) assert.equal(recordAgentLaunch(s.session, 'implementer', s.env, { writer: true, about }).state, 'recorded', `launch ${n + 1}`);
  assert.ok(readFileSync(storeOf(s)).length <= 64 * 1024);
});

test('a stop stores stoppedAt for the agent id', () => {
  const s = newSession();
  launch(s);
  recordAgentStart(s.session, 'agent-stop-1', 'scout', s.env);
  const before = Date.now();
  recordAgentStop(s.session, 'agent-stop-1', 'scout', s.env);
  const stoppedAt = readStore(s).stoppedAt['agent-stop-1'];
  assert.ok(stoppedAt >= before && stoppedAt <= Date.now());
});

// ---- settings and doctor ----

const GOOD_LIVE = {
  disableWorkflows: true,
  env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5' },
  permissions: { deny: ['Workflow'] },
};

function doctorCheck(live) {
  const home = makeTempDir('agent-cap-doctor-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  if (live !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(live));
  return spawnSync('bash', [DOCTOR], { env: { ...process.env, HOME: home, DOCTOR_ONLY: 'check_agent_cap' }, encoding: 'utf8' });
}

test('check_agent_cap is ok when the live settings match', (t) => {
  if (!hasJq) return t.diagnostic('not run: jq not installed');
  const run = doctorCheck(GOOD_LIVE);
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^ok\s+agent cap: workflows off, deny Workflow, env cap 5 = MAX_RUNNING_AGENTS/m);
});

test('check_agent_cap prints a FAIL line for each drift', (t) => {
  if (!hasJq) return t.diagnostic('not run: jq not installed');
  const cases = [
    [{ ...GOOD_LIVE, disableWorkflows: false }, /FAIL\s+settings\.json: disableWorkflows is not true/],
    [{ ...GOOD_LIVE, disableWorkflows: undefined }, /FAIL\s+settings\.json: disableWorkflows is not true/],
    [{ ...GOOD_LIVE, permissions: { deny: ['Bash(rm *)'] } }, /FAIL\s+settings\.json: permissions\.deny lacks Workflow/],
    [{ ...GOOD_LIVE, env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5' } }, /FAIL\s+settings\.json: env CLAUDE_CODE_DISABLE_WORKFLOWS is not 1/],
    [{ ...GOOD_LIVE, env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } }, /FAIL\s+settings\.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset/],
    [{ ...GOOD_LIVE, env: { ...GOOD_LIVE.env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20' } }, /FAIL\s+settings\.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is 20, the hook caps at 5/],
  ];
  for (const [live, pattern] of cases) {
    const run = doctorCheck(live);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, pattern);
  }
  assert.match(doctorCheck(undefined).stdout, /FAIL\s+settings\.json missing or invalid JSON/);
});
