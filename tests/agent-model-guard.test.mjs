// Tests for home/hooks/agent-model-guard.mjs: guardedAgentInput table plus the stdin/stdout contract of the hook
// (a temp HOME holds the session's mode file, so the real ~/.claude state is never read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedAgentInput } from '../home/hooks/agent-model-guard.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/agent-model-guard.mjs', import.meta.url));
const BASE = { description: 'look', prompt: 'find x' };

test('guardedAgentInput: Explore without model gets sonnet, Plan gets opus, in both lead modes', () => {
  for (const mode of ['extra-high', 'ultra-high']) {
    assert.deepEqual(guardedAgentInput(mode, { ...BASE, subagent_type: 'Explore' }), { ...BASE, subagent_type: 'Explore', model: 'sonnet' });
    assert.deepEqual(guardedAgentInput(mode, { ...BASE, subagent_type: 'Plan' }), { ...BASE, subagent_type: 'Plan', model: 'opus' });
  }
});

test('guardedAgentInput: an explicit model is kept', () => {
  assert.equal(guardedAgentInput('ultra-high', { ...BASE, subagent_type: 'Explore', model: 'haiku' }), null);
  assert.equal(guardedAgentInput('ultra-high', { ...BASE, subagent_type: 'Plan', model: 'fable' }), null);
});

test('guardedAgentInput: an empty model counts as absent (it would inherit the lead)', () => {
  assert.equal(guardedAgentInput('ultra-high', { ...BASE, subagent_type: 'Explore', model: '' }).model, 'sonnet');
});

test('guardedAgentInput: forks, other agent types and odd input are untouched', () => {
  assert.equal(guardedAgentInput('ultra-high', { ...BASE }), null); // fork: no subagent_type
  assert.equal(guardedAgentInput('ultra-high', { ...BASE, subagent_type: 'scout' }), null);
  assert.equal(guardedAgentInput('ultra-high', { ...BASE, subagent_type: 'toString' }), null);
  for (const bad of [undefined, null, 'Explore', 42]) assert.equal(guardedAgentInput('ultra-high', bad), null);
});

test('guardedAgentInput: other modes are untouched', () => {
  for (const mode of ['normal', 'medium', 'high']) assert.equal(guardedAgentInput(mode, { ...BASE, subagent_type: 'Explore' }), null);
});

function run(mode, stdin) {
  const home = mkdtempSync(join(tmpdir(), 'model-guard-'));
  mkdirSync(join(home, '.claude', 'state', 'modes'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'modes', 'sess1'), `${mode}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_MODE;
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env });
}

test('hook: ultra-high Explore without model prints an allow decision with the full updated input', () => {
  const toolInput = { ...BASE, subagent_type: 'Explore' };
  const r = run('ultra-high', JSON.stringify({ session_id: 'sess1', tool_name: 'Agent', tool_input: toolInput }));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, model: 'sonnet' } },
  });
});

test('hook: explicit model, medium mode and bad JSON exit 0 with no output', () => {
  const explore = { session_id: 'sess1', tool_input: { ...BASE, subagent_type: 'Explore', model: 'haiku' } };
  for (const [mode, stdin] of [['ultra-high', JSON.stringify(explore)], ['medium', JSON.stringify({ ...explore, tool_input: { ...BASE, subagent_type: 'Explore' } })], ['ultra-high', 'not json']]) {
    const r = run(mode, stdin);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
