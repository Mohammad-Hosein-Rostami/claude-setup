// Tests for AskUserQuestion in home/hooks/permission-timed-allow.mjs: one timed dialog per question call; no answer in 30 s
// (CLAUDE_PERMISSION_TIMEOUT_S) or "Use recommended" answers every question with its "(Recommended)" option, else its first
// option; "Answer in terminal", a failed dialog or no GUI print nothing, so Claude Code's own question UI appears.
// The dialog is injected (permissionReply's third argument); no test opens a real dialog.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { permissionReply } from '../home/hooks/permission-timed-allow.mjs';
import { hookEnv, tempLogPath } from './hook-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/permission-timed-allow.mjs', import.meta.url));
// Built from parts so this file never holds a string that looks like a real credential.
const SECRET = ['sk', 'ant', 'api03', 'Zx9Qw', '3Er5T', 'y7Ui1'].join('-');

const privateEnv = (extra = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'question-home-'));
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
};

/** A dialog stand-in that records each request and answers with `decision` / `outcome`. */
function fakeAnswer(decision, outcome) {
  const calls = [];
  const answer = (request) => {
    calls.push(request);
    return { decision, outcome, reason: `fake ${outcome}` };
  };
  return { answer, calls };
}

const question = (text, labels, extra = {}) => ({
  question: text, header: text.slice(0, 12), options: labels.map((label) => ({ label, description: `about ${label}` })), multiSelect: false, ...extra,
});
const askInput = (questions) => ({
  session_id: 'session-q-1', cwd: '/work/proj', permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions },
});
const decisionOf = (stdout) => {
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PermissionRequest');
  return out.decision;
};
const WATCHER = question('Where should the watcher run?', ['PC watcher', 'Mac watcher (Recommended)', 'None']);

test('no answer in 30 s or "Use recommended": the option marked (Recommended) is taken, the questions echoed back', () => {
  for (const outcome of ['timeout', 'allow']) {
    const { answer, calls } = fakeAnswer('allow', outcome);
    const decision = decisionOf(permissionReply(askInput([WATCHER]), privateEnv(), answer));
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: { questions: [WATCHER], answers: { 'Where should the watcher run?': 'Mac watcher (Recommended)' } } });
    assert.equal(calls.length, 1, 'one dialog');
    assert.equal(calls[0].timeoutS, 30);
    assert.deepEqual(calls[0].buttons, { accept: 'Use recommended', decline: 'Answer in terminal' });
    assert.deepEqual(calls[0].details, [{ label: 'Where should', value: 'Where should the watcher run? -> Mac watcher (Recommended)' }]);
  }
});

test('no option marked (Recommended): the first option is taken', () => {
  const plain = question('Which format?', ['Summary', 'Detailed']);
  const decision = decisionOf(permissionReply(askInput([plain]), privateEnv(), fakeAnswer('allow', 'timeout').answer));
  assert.deepEqual(decision.updatedInput.answers, { 'Which format?': 'Summary' });
});

test('several questions: one dialog lists each, each gets its own answer; CLAUDE_PERMISSION_TIMEOUT_S sets the wait', () => {
  const questions = [WATCHER, question('Which format?', ['Summary', 'Detailed']), question('Ship it?', ['No', 'Yes (Recommended)'])];
  const { answer, calls } = fakeAnswer('allow', 'timeout');
  const decision = decisionOf(permissionReply(askInput(questions), privateEnv({ CLAUDE_PERMISSION_TIMEOUT_S: '12' }), answer));
  assert.deepEqual(decision.updatedInput.answers, { 'Where should the watcher run?': 'Mac watcher (Recommended)', 'Which format?': 'Summary', 'Ship it?': 'Yes (Recommended)' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutS, 12);
  assert.deepEqual(calls[0].details.map((line) => line.value), [
    'Where should the watcher run? -> Mac watcher (Recommended)', 'Which format? -> Summary', 'Ship it? -> Yes (Recommended)',
  ]);
});

test('multiSelect: the answer is that single option label', () => {
  const sections = question('Which sections?', ['Intro', 'Body (Recommended)', 'End'], { multiSelect: true });
  const decision = decisionOf(permissionReply(askInput([sections]), privateEnv(), fakeAnswer('allow', 'timeout').answer));
  assert.deepEqual(decision.updatedInput.answers, { 'Which sections?': 'Body (Recommended)' });
});

test('"Answer in terminal", a failed or killed dialog and no GUI print nothing: never an invented answer', () => {
  for (const [decision, outcome] of [['deny', 'deny'], ['ask', 'dialog-failed'], ['ask', 'no-gui']]) {
    assert.equal(permissionReply(askInput([WATCHER]), privateEnv(), fakeAnswer(decision, outcome).answer), '', outcome);
  }
});

test('input that is not a well-formed question list gets no dialog and no answer', () => {
  const bad = [[], undefined, [{ question: 'Q?', options: [] }], [{ question: 'Q?', options: [{ description: 'no label' }] }], [{ options: [{ label: 'A' }] }]];
  for (const questions of bad) {
    const { answer, calls } = fakeAnswer('allow', 'timeout');
    assert.equal(permissionReply(askInput(questions), privateEnv(), answer), '', JSON.stringify(questions));
    assert.equal(calls.length, 0, JSON.stringify(questions));
  }
});

test('a secret in a question never reaches the decision log', () => {
  const env = privateEnv();
  permissionReply(askInput([question(`Rotate ${SECRET}?`, ['Yes', 'No'])]), env, fakeAnswer('allow', 'timeout').answer);
  const logged = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8');
  assert.ok(logged.includes('AskUserQuestion'));
  assert.ok(!logged.includes(SECRET));
});

test('hook contract: an AskUserQuestion prompt with no GUI prints nothing and exits 0', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(askInput([WATCHER])), encoding: 'utf8', env: hookEnv(privateEnv()) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
