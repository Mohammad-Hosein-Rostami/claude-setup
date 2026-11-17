// Behaviour of home/workflows/step.js: one agent with the given type, model, effort and a `<row>:step` label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWellFormedCalls, readMeta, runScript } from './workflow-sandbox.mjs';
import { readFileSync } from 'node:fs';

const STEP = join(dirname(fileURLToPath(import.meta.url)), '..', 'home', 'workflows', 'step.js');
const GOOD = { row: 'impl-3', agentType: 'architect', prompt: 'design the cache', model: 'opus', effort: 'high' };

test('step runs one agent with the type, model and effort it was given and returns its text', async () => {
  const run = await runScript(STEP, GOOD, { replies: [{ match: /^impl-3:step$/, reply: 'DESIGN' }] });
  assert.equal(run.error, null);
  assert.equal(run.result, 'DESIGN');
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].prompt, 'design the cache');
  assert.deepEqual(run.calls[0].opts, { label: 'impl-3:step', phase: 'Step', agentType: 'architect', model: 'opus', effort: 'high' });
  assertWellFormedCalls(run.calls, 'impl-3', readMeta(readFileSync(STEP, 'utf8')).meta);
});

test('step passes isolation only when asked, and returns null when the agent was stopped', async () => {
  const run = await runScript(STEP, { ...GOOD, isolation: 'worktree' }, { replies: [{ match: /./, reply: null }] });
  assert.equal(run.calls[0].opts.isolation, 'worktree');
  assert.equal(run.result, null);
});

test('step refuses a wrong-typed optional isolation before any agent starts', async () => {
  const run = await runScript(STEP, { ...GOOD, isolation: 7 }, { replies: [{ match: /./, reply: 'x' }] });
  assert.equal(run.error?.message, 'step: args.isolation must be a string');
  assert.equal(run.calls.length, 0);
});
