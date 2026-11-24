// Tests for the terminal-answer marker (home/hooks/lib/question-answered.mjs) and its PostToolUse hook (home/hooks/question-answered.mjs):
// when the owner answers an AskUserQuestion in the terminal, PostToolUse writes a marker keyed by session, agent and question texts;
// the PermissionRequest hook reads the same key to close its popups. No dialog is opened here.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { markQuestionAnswered, questionAnsweredDir, questionTexts, wasQuestionAnswered } from '../home/hooks/lib/question-answered.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/question-answered.mjs', import.meta.url));
const SESSION = 'session-marker-1';
const MARK_TTL_MS = 15 * 60 * 1000; // the marker store forgets a mark after 15 min
const privateEnv = () => {
  const home = makeTempDir('marker-home-');
  return { HOME: home, USERPROFILE: home };
};
const call = (extra = {}) => ({ session: SESSION, agentId: undefined, questions: ['Where?', 'Ship it?'], ...extra });
const toolInput = { questions: [{ question: 'Where?', options: [{ label: 'A' }] }, { question: 'Ship it?', options: [{ label: 'B' }] }] };

test('questionTexts: the question texts of a well-formed input, undefined for anything else', () => {
  assert.deepEqual(questionTexts(toolInput), ['Where?', 'Ship it?']);
  for (const bad of [undefined, {}, { questions: [] }, { questions: [{ question: 5 }] }, { questions: 'x' }]) assert.equal(questionTexts(bad), undefined);
});

test('a mark written after the popup opened is seen; one written before is not (an earlier identical question)', () => {
  const env = privateEnv();
  markQuestionAnswered(call(), env, () => 10_000);
  assert.equal(wasQuestionAnswered(call(), 9_000, env), true);
  assert.equal(wasQuestionAnswered(call(), 10_001, env), false, 'a stale mark must not close a newer popup');
});

test('a mark for another session, agent or question set does not match', () => {
  const env = privateEnv();
  markQuestionAnswered(call(), env, () => 10_000);
  assert.equal(wasQuestionAnswered(call({ session: 'session-other' }), 0, env), false);
  assert.equal(wasQuestionAnswered(call({ agentId: 'agent-9' }), 0, env), false);
  assert.equal(wasQuestionAnswered(call({ questions: ['Where?'] }), 0, env), false);
  assert.equal(wasQuestionAnswered(call({ questions: ['Where?', 'Ship it?', 'More?'] }), 0, env), false);
});

test('no session id or an unwritable store: nothing is marked, nothing is seen, nothing throws', () => {
  const env = privateEnv();
  markQuestionAnswered(call({ session: undefined }), env);
  markQuestionAnswered(call({ session: '../escape' }), env);
  assert.equal(wasQuestionAnswered(call({ session: undefined }), 0, env), false);
  assert.equal(wasQuestionAnswered(call(), 0, env), false, 'a missing store means not answered');
});

test('a mark older than 15 min is dropped by the next write', () => {
  const env = privateEnv();
  markQuestionAnswered(call({ questions: ['Old?'] }), env, () => 1_000);
  markQuestionAnswered(call(), env, () => 1_000 + MARK_TTL_MS + 1);
  assert.equal(wasQuestionAnswered(call({ questions: ['Old?'] }), 0, env), false);
  assert.equal(wasQuestionAnswered(call(), 0, env), true);
  assert.deepEqual(readdirSync(questionAnsweredDir(env)).filter((name) => name.endsWith('.json')), [`${SESSION}.json`]);
});

const runHook = (input, env) => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: cleanEnv(env) });

test('PostToolUse hook: an AskUserQuestion result writes the mark the PermissionRequest hook looks for', () => {
  const env = privateEnv();
  const before = Date.now();
  const result = runHook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: SESSION, tool_input: { ...toolInput, answers: { 'Where?': 'A' } } }, env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(wasQuestionAnswered(call(), before, env), true);
});

test('PostToolUse hook: another tool, bad JSON or a bad question list writes nothing and exits 0', () => {
  const env = privateEnv();
  const inputs = ['not json', { tool_name: 'Bash', session_id: SESSION, tool_input: toolInput }, { tool_name: 'AskUserQuestion', session_id: SESSION, tool_input: { questions: [] } }, { tool_name: 'AskUserQuestion', tool_input: toolInput }];
  for (const input of inputs) {
    const result = runHook(input, env);
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, '');
  }
  assert.equal(wasQuestionAnswered(call(), 0, env), false);
});
