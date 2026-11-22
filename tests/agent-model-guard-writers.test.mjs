// Tests for the writer isolation gate of home/hooks/agent-model-guard.mjs and the finish record agent-budget.mjs keeps on SubagentStop
// (lib/writer-agents.mjs): a writing agent launched while another writing agent of the session still runs must carry
// `isolation: "worktree"`, else it is denied once with advice and the identical call sent again runs. Read-only agents are exempt.
// Each test gets a private HOME (launch record, advice store, agent files) and its own session id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { IDLE_MS, PENDING_MS } from '../home/hooks/lib/agent-launches.mjs';
import { callCounterPath } from '../home/hooks/lib/writer-agents.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const BUDGET = fileURLToPath(new URL('../home/hooks/agent-budget.mjs', import.meta.url));
const HOOK_TIMEOUT_MS = 5000;
const PARALLEL_LAUNCHES = 6;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
let counter = 0;

/** A private HOME; launch(toolInput) sends one Agent call and returns its hookSpecificOutput (null when silent); stop(...) ends one. */
function writerSession() {
  const home = makeTempDir('writer-gate-home-');
  const project = makeTempDir('writer-gate-project-');
  const session = `writers-${process.pid}-${counter++}`;
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project });
  const input = (toolInput) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: project, tool_name: 'Agent', tool_input: toolInput });
  const parse = ({ status, stdout, stderr }) => {
    assert.equal(status, 0, stderr);
    return stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
  };
  return {
    home,
    session,
    launch: (toolInput) => parse(spawnSync(process.execPath, [GUARD], { input: input(toolInput), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS })),
    launchAsync: (toolInput) => new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], { env });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => resolve(parse({ status, stdout, stderr: '' })));
      child.stdin.end(input(toolInput));
    }),
    start: (agentId, agentType) => {
      const startInput = { hook_event_name: 'SubagentStart', session_id: session, agent_id: agentId, agent_type: agentType };
      const { status, stderr } = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(startInput), encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
    },
    store: (record) => {
      const dir = join(home, '.claude', 'state', 'agent-writers');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${session}.json`), JSON.stringify(record), { mode: 0o600 });
    },
    stop: (agentId, agentType) => {
      const stopInput = { hook_event_name: 'SubagentStop', session_id: session, agent_id: agentId, agent_type: agentType, last_assistant_message: 'done', stop_hook_active: false };
      const { status, stderr } = spawnSync(process.execPath, [BUDGET], { input: JSON.stringify(stopInput), encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
    },
  };
}

const denied = (out) => out?.permissionDecision === 'deny';
const writer = (type, extra = {}) => ({ description: 'build', prompt: `do the ${type} job`, subagent_type: type, ...extra });

test('a second writer without isolation while a writer runs is denied once with the worktree advice; the identical retry runs', () => {
  const s = writerSession();
  assert.ok(!denied(s.launch(writer('general-purpose'))), 'the first writer runs');
  const second = s.launch(writer('implementer'));
  assert.ok(denied(second), 'a second writer in the shared folder');
  assert.match(second.permissionDecisionReason, /isolation: "worktree"/);
  assert.match(second.permissionDecisionReason, /another writing agent .* still running/i);
  assert.ok(!denied(s.launch(writer('implementer'))), 'the identical call sent again runs');
  assert.ok(denied(s.launch(writer('test-writer'))), 'two writers run now: a third one is denied too');
});

test('a writer with isolation "worktree" runs next to running writers, and does not stop a writer without isolation', () => {
  const s = writerSession();
  assert.equal(s.launch(writer('ui-implementer', { isolation: 'worktree', prompt: 'MATRIX: none: one-file tweak, no Figma frame' })), null);
  assert.ok(!denied(s.launch(writer('implementer'))), 'an isolated writer does not stop a non-isolated one');
  assert.equal(s.launch(writer('implementer', { isolation: 'worktree', prompt: 'other job' })), null);
});

test('read-only agents are exempt and never count as running writers; an omitted type is general-purpose (a writer)', () => {
  const readOnlyTypes = ['scout', 'runner', 'reviewer', 'security-auditor', 'Explore', 'Plan', 'architect'];
  for (const type of readOnlyTypes) {
    const s = writerSession(); // one session per type: the agent cap (5 running at once) counts read-only agents too
    mkdirSync(join(s.home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(s.home, '.claude', 'agents', 'architect.md'), '---\nname: architect\ntools: Read, Grep, Write\n---\n');
    assert.ok(!denied(s.launch(writer(type))), `${type} alone`);
    assert.ok(!denied(s.launch(writer(type, { prompt: 'second' }))), `${type} next to ${type}`);
    assert.ok(!denied(s.launch({ description: 'x', prompt: 'no type' })), `the first writer runs although ${type} ran`);
    assert.ok(!denied(s.launch(writer(type, { prompt: 'while a writer runs' }))), `${type} while a writer runs`);
    assert.ok(denied(s.launch({ description: 'y', prompt: 'no type again' })), `a second writer next to the running one (${type} did not count)`);
  }
});

test('an agent file whose tools include Write or Edit is a writer; one without, a fork and a plugin agent are not', () => {
  const s = writerSession();
  mkdirSync(join(s.home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(s.home, '.claude', 'agents', 'doc-writer.md'), '---\nname: doc-writer\ntools: Read, Edit\n---\n');
  writeFileSync(join(s.home, '.claude', 'agents', 'lister.md'), '---\nname: lister\ntools: Read, Grep\n---\n');
  assert.ok(!denied(s.launch(writer('doc-writer'))));
  for (const type of ['lister', 'fork', 'some-plugin:helper']) assert.ok(!denied(s.launch(writer(type))), type);
  assert.ok(denied(s.launch(writer('doc-writer', { prompt: 'second doc job' }))), 'two doc-writers');
});

test('a writer that stopped (SubagentStop) no longer counts; a repeated stop of the same agent ends only one launch', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.launch(writer('implementer', { prompt: 'two' })); // denied once
  s.launch(writer('implementer', { prompt: 'two' })); // the identical retry runs: two plain writers are recorded
  s.stop('agent-1', 'implementer');
  s.stop('agent-1', 'implementer'); // a stop blocked by another gate comes again
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'three' }))), 'one implementer still runs');
  s.stop('agent-2', 'implementer');
  assert.ok(!denied(s.launch(writer('implementer', { prompt: 'four' }))), 'all writers stopped');
  s.stop('agent-3', 'scout');
  assert.ok(denied(s.launch(writer('general-purpose'))), 'a read-only stop ends no writer');
});

test('writers launched in parallel in one message: exactly one runs without isolation', async () => {
  const s = writerSession();
  const outs = await Promise.all(Array.from({ length: PARALLEL_LAUNCHES }, (_, i) => s.launchAsync(writer('implementer', { prompt: `lane ${i}` }))));
  assert.equal(outs.filter((out) => !denied(out)).length, 1, JSON.stringify(outs));
});

test('a launch older than the stale limit no longer counts (an agent that ended without SubagentStop)', () => {
  const s = writerSession();
  const dir = join(s.home, '.claude', 'state', 'agent-writers');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${s.session}.json`), JSON.stringify({ launches: [{ type: 'implementer', at: Date.now() - FIVE_HOURS_MS }], stopped: [] }), { mode: 0o600 });
  assert.ok(!denied(s.launch(writer('implementer'))));
});

// Audit of db40977 (S3): a launch the owner denied, a sibling hook denied or Esc cut before it started has no SubagentStart and never a
// SubagentStop; it stayed "running" for 4 h and every later writer was denied once with a phantom "wait until it has finished".
const MINUTE_MS = 60 * 1000;

test('a launch with no SubagentStart counts only for PENDING_MS (a denied or never-started launch is no running writer after that)', () => {
  const s = writerSession();
  s.store({ launches: [{ type: 'implementer', at: Date.now() - PENDING_MS - 1000 }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer'))), 'the never-started launch has expired');
  s.store({ launches: [{ type: 'implementer', at: Date.now() - PENDING_MS + 30_000 }], stopped: [] });
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'just launched next to it' }))), 'a launch of a moment ago may still be starting');
});

test('a started writer (SubagentStart) counts while it works and stops counting after IDLE_MS without a tool call', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.start('agent-started-1', 'implementer');
  const record = JSON.parse(readFileSync(join(s.home, '.claude', 'state', 'agent-writers', `${s.session}.json`), 'utf8'));
  assert.equal(record.launches[0].agent, 'agent-started-1');
  s.store({ launches: [{ ...record.launches[0], at: Date.now() - PENDING_MS - MINUTE_MS }], stopped: [] });
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'two' }))), 'started 3 min ago: still running');
  s.store({ launches: [{ ...record.launches[0], at: Date.now() - IDLE_MS - MINUTE_MS }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer', { prompt: 'three' }))), 'no tool call for over IDLE_MS: no longer running');
});

test('a tool call of the started writer (its call counter) keeps it running past IDLE_MS from its start', () => {
  const s = writerSession();
  const agent = `agent-busy-${process.pid}-${counter++}`;
  s.store({ launches: [{ type: 'implementer', at: Date.now() - IDLE_MS - MINUTE_MS, agent }], stopped: [] });
  const counterFile = callCounterPath(s.session, agent);
  mkdirSync(dirname(counterFile), { recursive: true });
  writeFileSync(counterFile, '...');
  assert.ok(denied(s.launch(writer('implementer', { prompt: 'next to a busy one' }))));
  rmSync(counterFile, { force: true });
});

test('a launch dated ahead of the clock never counts (clock step back, a planted record)', () => {
  const s = writerSession();
  s.store({ launches: [{ type: 'implementer', at: Date.now() + 10 * MINUTE_MS }], stopped: [] });
  assert.ok(!denied(s.launch(writer('implementer'))));
});

test('a stop ends the launch of its own agent id first', () => {
  const s = writerSession();
  s.launch(writer('implementer', { prompt: 'one' }));
  s.launch(writer('implementer', { prompt: 'two', isolation: 'worktree' }));
  s.start('agent-a', 'implementer');
  s.start('agent-b', 'implementer');
  s.stop('agent-b', 'implementer');
  const { launches } = JSON.parse(readFileSync(join(s.home, '.claude', 'state', 'agent-writers', `${s.session}.json`), 'utf8'));
  assert.deepEqual(launches.map((launch) => launch.agent), ['agent-a']);
});
