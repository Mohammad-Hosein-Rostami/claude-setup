// Tests for home/hooks/agent-model-guard.mjs: guardedAgentInput table plus the stdin/stdout contract of the hook
// (a temp HOME holds the session's mode file, so the real ~/.claude state is never read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedAgentInput } from '../home/hooks/agent-model-guard.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const BASE = { description: 'look', prompt: 'find x' };

test('guardedAgentInput: Explore without model gets sonnet, Plan gets opus (the same in every mode)', () => {
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'Explore' }), { ...BASE, subagent_type: 'Explore', model: 'sonnet' });
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'Plan' }), { ...BASE, subagent_type: 'Plan', model: 'opus' });
});

test('guardedAgentInput: general-purpose and a call with no subagent_type get sonnet', () => {
  assert.deepEqual(guardedAgentInput({ ...BASE }), { ...BASE, model: 'sonnet' });
  assert.deepEqual(guardedAgentInput({ ...BASE, subagent_type: 'general-purpose' }), { ...BASE, subagent_type: 'general-purpose', model: 'sonnet' });
});

test('guardedAgentInput: an explicit model is kept', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Explore', model: 'haiku' }), null);
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: 'fable' }), null);
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: 'sonnet' }), null);
  assert.equal(guardedAgentInput({ ...BASE, model: 'opus' }), null);
});

test('guardedAgentInput: an empty model counts as absent (it would inherit the lead)', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Explore', model: '' }).model, 'sonnet');
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'Plan', model: '' }).model, 'opus');
  assert.equal(guardedAgentInput({ ...BASE, model: '' }).model, 'sonnet');
});

test('guardedAgentInput: forks, the repo agents (they pin their own model) and odd input are untouched', () => {
  assert.equal(guardedAgentInput({ ...BASE, subagent_type: 'fork' }), null);
  for (const type of ['scout', 'security-auditor', 'architect', 'reviewer', 'implementer', 'toString', 'some-plugin:agent']) {
    assert.equal(guardedAgentInput({ ...BASE, subagent_type: type }), null);
  }
  for (const bad of [undefined, null, 'Explore', 42]) assert.equal(guardedAgentInput(bad), null);
});

// The hook runs in the temp HOME, so no STATUS.md of this repo adds a line to the brief.
function run(mode, stdin) {
  const home = makeTempDir('model-guard-');
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', 'sess1'), `${mode}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_MODE;
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env, cwd: home });
}

test('hook: a Plan call without model gets opus in all five modes; an explicit model wins', () => {
  const plan = (extra) => JSON.stringify({ session_id: 'sess1', tool_input: { ...BASE, subagent_type: 'Plan', ...extra } });
  for (const mode of ['normal', 'medium', 'high', 'extra-high', 'ultra-high']) {
    assert.equal(JSON.parse(run(mode, plan({})).stdout).hookSpecificOutput.updatedInput.model, 'opus', mode);
    assert.equal(JSON.parse(run(mode, plan({ model: 'sonnet' })).stdout).hookSpecificOutput.updatedInput.model, 'sonnet', `${mode}: explicit`);
  }
});

test('hook: ultra-high Explore without model prints an allow decision with the full updated input', () => {
  const toolInput = { ...BASE, subagent_type: 'Explore' };
  const r = run('ultra-high', JSON.stringify({ session_id: 'sess1', tool_name: 'Agent', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, model: 'sonnet' } },
  });
});

test('hook: medium mode general-purpose gets sonnet too', () => {
  const toolInput = { ...BASE, subagent_type: 'general-purpose' };
  const r = run('medium', JSON.stringify({ session_id: 'sess1', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('hook: a long non-ASCII prompt reaches the agent intact (stdin is decoded once, not chunk by chunk)', () => {
  const toolInput = { ...BASE, subagent_type: 'Explore', prompt: 'سلام دنیا، این یک آزمایش است. '.repeat(10000) }; // about 530 KB, mostly 2-byte characters: many 64 KB stdin chunks
  const r = run('medium', JSON.stringify({ session_id: 'sess1', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.prompt, toolInput.prompt);
});

test('hook: explicit model, a fork, a pinned repo agent and bad JSON exit 0 with no output', () => {
  const explore = { session_id: 'sess1', tool_input: { ...BASE, subagent_type: 'Explore', model: 'haiku' } };
  const asType = (subagent_type) => JSON.stringify({ ...explore, tool_input: { ...BASE, subagent_type } });
  for (const [mode, stdin] of [['ultra-high', JSON.stringify(explore)], ['medium', asType('fork')], ['medium', asType('security-auditor')], ['ultra-high', 'not json']]) {
    const r = run(mode, stdin);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
