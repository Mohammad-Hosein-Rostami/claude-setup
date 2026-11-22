// Tests for the Stop-block counter (home/hooks/lib/stop-block-count.mjs): a hook runs once per Stop event, so its second block of
// the chain is the next continuation even when the model's reply text is identical (the old rule merged them into one count and
// the cap warning came late); gates of one event (spawned together, so each started before the first one blocked) still count once, while
// every continuation counts once even when different hooks block back to back on the same reply; the counts file holds 100 agents under
// its own cap; two hooks that block at the same moment keep the count file whole.
// Each test has a private HOME; the counter reads and writes only under it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { countBlock, readRecords, recordsDir, STOP_BLOCK_CAP } from '../home/hooks/lib/stop-block-count.mjs';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const COUNTER = fileURLToPath(new URL('../home/hooks/lib/stop-block-count.mjs', import.meta.url));
const SAME_REPLY = 'Done. Everything is committed.';
const SPAWN_LEAD_MS = 50;
const AGENTS_STORED = 100; // the counter keeps this many agents per session
const MAX_COUNTS_FILE_BYTES = 64 * 1024; // the counter's own cap
/** The spawn time of the gates of one event: a clock tick after the previous block and a tick before the next one (a millisecond clock). */
const spawnGates = () => {
  const tick = () => { const start = Date.now(); while (Date.now() === start); };
  tick();
  const spawnedAt = Date.now();
  tick();
  return spawnedAt;
};
const privateEnv = () => {
  const home = makeTempDir('stop-cap-home-');
  return { HOME: home, USERPROFILE: home };
};
const stopInput = (session, extra = {}) => ({ hook_event_name: 'Stop', session_id: session, stop_hook_active: true, last_assistant_message: SAME_REPLY, ...extra });

test('one hook blocking every continuation with the same reply counts each block, and the cap record appears once past the cap', () => {
  const env = privateEnv();
  const first = countBlock('commit-gate', stopInput('same-reply-1', { stop_hook_active: false }), env);
  assert.equal(first.count, 1);
  for (let expected = 2; expected <= STOP_BLOCK_CAP + 1; expected += 1) {
    const result = countBlock('commit-gate', stopInput('same-reply-1'), env);
    assert.equal(result.count, expected, `block ${expected} with the same reply text`);
    assert.equal(result.overridden, expected > STOP_BLOCK_CAP);
  }
  const records = readRecords(env);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, 'gate overridden: commit-gate');
  countBlock('commit-gate', stopInput('same-reply-1'), env);
  assert.equal(readRecords(env).length, 1, 'the override is recorded once per chain');
});

test('gates of one Stop event (different hooks, same reply) still count once; the next continuation of any of them counts again', () => {
  const env = privateEnv();
  const input = stopInput('same-event-1');
  const spawnedAt = Date.now() - SPAWN_LEAD_MS; // the gates of one event are spawned together, before any of them blocks
  assert.equal(countBlock('commit-gate', input, env, spawnedAt).count, 1);
  assert.equal(countBlock('git-tidy-gate', input, env, spawnedAt).count, 1);
  assert.equal(countBlock('ask-gate', input, env, spawnedAt).count, 1);
  assert.equal(countBlock('git-tidy-gate', input, env).count, 2, 'the same hook again is a new event');
});

test('a counts file stored before eventHooks existed still reads: no crash, the chain goes on', () => {
  const env = privateEnv();
  const stored = { agents: { lead: { n: 3, at: Date.now(), key: 'old-key', hooks: ['commit-gate'], recorded: false } } };
  assert.equal(writeSessionFile(join(recordsDir(env), 'counts'), 'old-entry-1', JSON.stringify(stored)), true);
  assert.equal(countBlock('commit-gate', stopInput('old-entry-1'), env).count, 4);
});

test('two Stop hooks blocking at the same moment on one session lose no update (the count file lock holds)', async () => {
  const env = privateEnv();
  const hooks = ['commit-gate', 'git-tidy-gate', 'ask-gate', 'final-reply-cap', 'ui-proof-gate', 'done-check'];
  const script = `import(${JSON.stringify(COUNTER)}).then(({ countBlock }) => {
    const input = ${JSON.stringify(stopInput('parallel-1'))};
    countBlock(process.argv[1], input, process.env, Number(process.argv[2]));
  });`;
  const spawnedAt = Date.now() - SPAWN_LEAD_MS;
  await Promise.all(hooks.map((hook) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, hook, String(spawnedAt)], { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${hook} exited ${code}`))));
  })));
  const stored = JSON.parse(readFileSync(join(recordsDir(env), 'counts', 'parallel-1.json'), 'utf8'));
  assert.equal(stored.agents.lead.n, 1, 'one event');
  assert.deepEqual([...stored.agents.lead.eventHooks].sort(), [...hooks].sort(), 'every hook that blocked is kept');
});

test('different hooks blocking back to back continuations on one reply (A, B, A, ...) count each continuation', () => {
  const env = privateEnv();
  const continuations = 9;
  let result = null;
  for (let index = 0; index < continuations; index += 1) {
    result = countBlock(index % 2 === 0 ? 'done-check' : 'commit-gate', stopInput('alternate-1', { stop_hook_active: index > 0 }), env);
    assert.equal(result.count, index + 1, `continuation ${index + 1}`);
  }
  assert.equal(result.overridden, true);
  assert.equal(readRecords(env).length, 1);
  assert.equal(readRecords(env)[0].text, 'gate overridden: done-check, commit-gate');
});

test('a gate started after the last block is the next continuation, one started before it joins the event', () => {
  const env = privateEnv();
  assert.equal(countBlock('commit-gate', stopInput('start-time-1'), env, Date.now() - SPAWN_LEAD_MS).count, 1);
  assert.equal(countBlock('ask-gate', stopInput('start-time-1'), env, Date.now() - SPAWN_LEAD_MS).count, 1);
  assert.equal(countBlock('git-tidy-gate', stopInput('start-time-1'), env, Date.now() + SPAWN_LEAD_MS).count, 2);
});

test('the counts file keeps 100 agents under its own cap and every one keeps counting (all gates blocking, two continuations each)', () => {
  const env = privateEnv();
  const gates = ['commit-gate', 'git-tidy-gate', 'ask-gate', 'final-reply-cap', 'ui-proof-gate', 'done-check', 'agent-budget'];
  const agents = Array.from({ length: AGENTS_STORED }, (_, index) => `agent${String(index).padStart(12, '0')}`);
  const block = (agent, active) => {
    const spawnedAt = spawnGates(); // one event: every gate was spawned before the first one blocks
    return gates.map((gate) => countBlock(gate, stopInput('agents-100', { agent_id: agent, hook_event_name: 'SubagentStop', stop_hook_active: active }), env, spawnedAt));
  };
  for (const agent of agents) {
    block(agent, false);
    block(agent, true);
  }
  const file = join(recordsDir(env), 'counts', 'agents-100.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(stored.agents).length, AGENTS_STORED);
  assert.ok(statSync(file).size <= MAX_COUNTS_FILE_BYTES, `${statSync(file).size} bytes`);
  const oldest = block(agents[0], true)[0];
  assert.equal(oldest.count, 3, 'the oldest of 100 agents still has its count');
});

test('an agent that keeps blocking moves to the newest place, so 100 others do not push it out', () => {
  const env = privateEnv();
  const input = (agent, active) => stopInput('agents-recent', { agent_id: agent, hook_event_name: 'SubagentStop', stop_hook_active: active });
  assert.equal(countBlock('commit-gate', input('busy-agent', false), env).count, 1);
  for (let index = 0; index < AGENTS_STORED - 1; index += 1) countBlock('commit-gate', input(`other-${index}`, false), env);
  assert.equal(countBlock('commit-gate', input('busy-agent', true), env).count, 2);
  for (let index = 0; index < AGENTS_STORED - 1; index += 1) countBlock('commit-gate', input(`later-${index}`, false), env);
  assert.equal(countBlock('commit-gate', input('busy-agent', true), env).count, 3, 'the agent was counted again after its turn, so it stayed');
});
