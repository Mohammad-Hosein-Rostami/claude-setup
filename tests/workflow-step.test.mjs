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

test('a UI agent without a usable MATRIX line is refused before it starts; a path or a none: reason of 15 characters passes (S3)', async () => {
  const ui = { ...GOOD, agentType: 'ui-implementer', isolation: 'worktree' };
  for (const prompt of ['build the form', 'see MATRIX: m.json', 'MATRIX:', 'MATRIX: none: short']) {
    const run = await runScript(STEP, { ...ui, prompt }, { replies: [{ match: /./, reply: 'x' }] });
    assert.match(String(run.error?.message), /a ui-implementer prompt needs a line `MATRIX:/, prompt);
    assert.equal(run.calls.length, 0);
  }
  for (const prompt of ['MATRIX: ~/m.json\nbuild the form', '  MATRIX: none: one file tweak, no figma\nfix it']) {
    const run = await runScript(STEP, { ...ui, prompt }, { replies: [{ match: /./, reply: 'x' }] });
    assert.equal(run.error, null, prompt);
  }
  const visual = await runScript(STEP, { ...GOOD, agentType: 'visual-qa', prompt: 'compare' }, { replies: [{ match: /./, reply: 'x' }] });
  assert.match(String(visual.error?.message), /a visual-qa prompt needs a line/);
});

test('a writer without isolation is refused unless alone is true; a reader needs neither (S3)', async () => {
  for (const agentType of ['implementer', 'ui-implementer', 'test-writer', 'general-purpose', 'claude']) {
    const prompt = 'MATRIX: m.json\nwrite it';
    const refused = await runScript(STEP, { ...GOOD, agentType, prompt }, { replies: [{ match: /./, reply: 'x' }] });
    assert.match(String(refused.error?.message), new RegExp(`a ${agentType} writes files: pass isolation "worktree", or alone true`), agentType);
    assert.equal(refused.calls.length, 0);
    for (const extra of [{ isolation: 'worktree' }, { alone: true }]) {
      const run = await runScript(STEP, { ...GOOD, agentType, prompt, ...extra }, { replies: [{ match: /./, reply: 'x' }] });
      assert.equal(run.error, null, `${agentType} ${JSON.stringify(extra)}`);
    }
  }
  const reader = await runScript(STEP, { ...GOOD, agentType: 'scout' }, { replies: [{ match: /./, reply: 'x' }] });
  assert.equal(reader.error, null);
});

test('statusFile puts the standing-rules line before the brief; without it the prompt is passed through untouched', async () => {
  const run = await runScript(STEP, { ...GOOD, statusFile: '/p/STATUS.md' }, { replies: [{ match: /./, reply: 'x' }] });
  assert.equal(run.calls[0].prompt, 'Read the `## Standing rules` of /p/STATUS.md first and follow them.\ndesign the cache');
  const bad = await runScript(STEP, { ...GOOD, alone: 'yes' }, { replies: [{ match: /./, reply: 'x' }] });
  assert.equal(bad.error?.message, 'step: args.alone must be a boolean');
});
