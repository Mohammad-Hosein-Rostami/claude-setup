// Tests for AskUserQuestion in home/hooks/lib/question-reply.mjs (run by home/hooks/permission-timed-allow.mjs): one timed popup PER question,
// each with its own CLAUDE_QUESTION_TIMEOUT_S wait (default 2 min), asked one after the other. No answer in the wait or "Use recommended"
// takes that question's "(Recommended)" option, else its first option; only a timeout adds a note for that answer (UNCONFIRMED).
// "Answer in terminal", a failed dialog or no GUI stop the loop and print nothing, so Claude Code's own question UI shows every question.
// When the owner turns the question down in the terminal (the transcript watch of lib/question-rejected.mjs) the open popup is closed and no
// later one opens; once the popups answered every question the asking marker is cleared. The dialog is injected (questionReply's `ask`) or, for the hook process tests, a fake dialog tool sits first on PATH. No real popup.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readAsking } from '../home/hooks/lib/asking-marker.mjs';
import { TERMINAL_AUTO_CONTINUE_S, questionReply, questionTimeoutSeconds } from '../home/hooks/lib/question-reply.mjs';
import { hookEnv, tempLogPath } from './hook-env.mjs';
import { fakePopup } from './fake-dialog-tool.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/permission-timed-allow.mjs', import.meta.url));
// Built from parts so this file never holds a string that looks like a real credential.
const SECRET = ['sk', 'ant', 'api03', 'Zx9Qw', '3Er5T', 'y7Ui1'].join('-');
const SESSION = 'session-q-1';
const WAIT_LIMIT_MS = 8000;
const POLL_MS = 10; // the marker poll of a test; the hook's own is slower

const privateEnv = (extra = {}) => {
  const home = makeTempDir('question-home-');
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: tempLogPath(), ...extra };
};

/** A popup stand-in: answers call n with `script[n]` ('allow', 'timeout', 'deny', 'ask'), records every request and how many were open at once. */
function fakeAsk(...script) {
  const calls = [];
  let open = 0;
  let maxOpen = 0;
  const ask = async (request) => {
    calls.push(request);
    maxOpen = Math.max(maxOpen, ++open);
    await new Promise((resolve) => setImmediate(resolve));
    open -= 1;
    const outcome = script[Math.min(calls.length - 1, script.length - 1)];
    const decision = { allow: 'allow', timeout: 'allow', deny: 'deny', ask: 'ask' }[outcome];
    return { decision, outcome: outcome === 'ask' ? 'dialog-failed' : outcome, reason: `fake ${outcome}` };
  };
  return Object.defineProperties(ask, { calls: { value: calls }, maxOpen: { get: () => maxOpen } });
}

const question = (text, labels, extra = {}) => ({
  question: text, header: text.slice(0, 12), options: labels.map((label) => ({ label, description: `about ${label}` })), multiSelect: false, ...extra,
});
const askInput = (questions) => ({
  session_id: SESSION, cwd: '/work/proj', permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions },
});
const reply = (input, env, ask, extra = {}) => questionReply(input, env, { ask, pollMs: POLL_MS, ...extra });
const WATCHER = question('Where should the watcher run?', ['PC watcher', 'Mac watcher (Recommended)', 'None']);
const FORMAT = question('Which format?', ['Summary', 'Detailed']);
const SHIP = question('Ship it?', ['No', 'Yes (Recommended)']);
const TIMEOUT_NOTE = 'No answer in 2 min: this option was taken by default, not chosen by the owner (UNCONFIRMED)';

test('"Use recommended": the option marked (Recommended) is taken, the questions echoed back, no note added', async () => {
  const ask = fakeAsk('allow');
  const decision = await reply(askInput([WATCHER]), privateEnv(), ask);
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { questions: [WATCHER], answers: { 'Where should the watcher run?': 'Mac watcher (Recommended)' } } });
  assert.equal(ask.calls.length, 1);
  assert.equal(ask.calls[0].timeoutS, 120);
  assert.deepEqual(ask.calls[0].buttons, { accept: 'Use recommended', decline: 'Answer in terminal' });
  assert.deepEqual(ask.calls[0].body, [
    '[Where should] Where should the watcher run?',
    'Options: 1 Mac watcher (recommended) · 2 PC watcher · 3 None',
    'No answer in 2 min → "Mac watcher" is taken and asked again in the next report.',
  ]);
});

test('no answer in 2 min: the same option is taken, but the answer carries a note that nobody chose it (UNCONFIRMED)', async () => {
  const decision = await reply(askInput([WATCHER]), privateEnv(), fakeAsk('timeout'));
  assert.deepEqual(decision.updatedInput.answers, { 'Where should the watcher run?': 'Mac watcher (Recommended)' });
  assert.deepEqual(decision.updatedInput.annotations, { 'Where should the watcher run?': { notes: TIMEOUT_NOTE } });
});

test('no answer: the note joins annotations already in the input and names the wait that passed', async () => {
  const input = askInput([WATCHER, SHIP]);
  input.tool_input.annotations = { 'Ship it?': { preview: 'diff' } };
  const decision = await reply(input, privateEnv({ CLAUDE_QUESTION_TIMEOUT_S: '45' }), fakeAsk('timeout'));
  const notes = TIMEOUT_NOTE.replace('2 min', '45 s');
  assert.deepEqual(decision.updatedInput.annotations, { 'Where should the watcher run?': { notes }, 'Ship it?': { preview: 'diff', notes } });
});

test('no option marked (Recommended): the first option is taken; multiSelect gets that single option', async () => {
  const sections = question('Which sections?', ['Intro', 'Body (Recommended)', 'End'], { multiSelect: true });
  const decision = await reply(askInput([FORMAT, sections]), privateEnv(), fakeAsk('timeout'));
  assert.deepEqual(decision.updatedInput.answers, { 'Which format?': 'Summary', 'Which sections?': 'Body (Recommended)' });
});

test('several questions: one popup per question, one after the other, each with its own wait and only its own lines', async () => {
  const ask = fakeAsk('timeout');
  const decision = await reply(askInput([WATCHER, FORMAT, SHIP]), privateEnv({ CLAUDE_QUESTION_TIMEOUT_S: '12' }), ask);
  assert.deepEqual(decision.updatedInput.answers, { 'Where should the watcher run?': 'Mac watcher (Recommended)', 'Which format?': 'Summary', 'Ship it?': 'Yes (Recommended)' });
  assert.equal(ask.calls.length, 3);
  assert.equal(ask.maxOpen, 1, 'never two popups at once');
  assert.deepEqual(ask.calls.map((call) => call.timeoutS), [12, 12, 12], 'a fresh wait for each question, not one wait shared');
  assert.deepEqual(ask.calls.map((call) => call.title), ['Claude asks (1 of 3)', 'Claude asks (2 of 3)', 'Claude asks (3 of 3)']);
  assert.deepEqual(ask.calls.map((call) => call.body.slice(0, 2)), [
    ['[Where should] Where should the watcher run?', 'Options: 1 Mac watcher (recommended) · 2 PC watcher · 3 None'],
    ['[Which format] Which format?', 'Options: 1 Summary (recommended) · 2 Detailed'],
    ['[Ship it?] Ship it?', 'Options: 1 Yes (recommended) · 2 No'],
  ]);
});

test('popups 2..N default (Enter) to "Answer in terminal", so an Enter typed in the terminal question cannot pick an answer; popup 1 keeps "Use recommended"', async () => {
  const ask = fakeAsk('allow');
  await reply(askInput([WATCHER, FORMAT, SHIP]), privateEnv(), ask);
  assert.deepEqual(ask.calls.map((call) => call.buttons.defaultButton), [undefined, 'decline', 'decline']);
  for (const call of ask.calls) assert.deepEqual([call.buttons.accept, call.buttons.decline], ['Use recommended', 'Answer in terminal'], 'both buttons stay clickable');
  const single = fakeAsk('allow');
  await reply(askInput([WATCHER]), privateEnv(), single);
  assert.equal(single.calls[0].buttons.defaultButton, undefined);
});

test('mixed: a click on questions 1 and 3 and a timeout on 2 -> only question 2 carries the UNCONFIRMED note', async () => {
  const decision = await reply(askInput([WATCHER, FORMAT, SHIP]), privateEnv(), fakeAsk('allow', 'timeout', 'allow'));
  assert.deepEqual(decision.updatedInput.annotations, { 'Which format?': { notes: TIMEOUT_NOTE } });
  assert.equal(Object.keys(decision.updatedInput.answers).length, 3);
});

test('"Answer in terminal" or a failed dialog on any question: nothing is answered and no later popup opens', async () => {
  for (const stop of ['deny', 'ask']) {
    const ask = fakeAsk('allow', stop, 'allow');
    assert.equal(await reply(askInput([WATCHER, FORMAT, SHIP]), privateEnv(), ask), undefined, stop);
    assert.equal(ask.calls.length, 2, `${stop}: question 3 is never shown`);
  }
});

test('input that is not a well-formed question list gets no popup and no answer', async () => {
  const bad = [[], undefined, [{ question: 'Q?', options: [] }], [{ question: 'Q?', options: [{ description: 'no label' }] }], [{ options: [{ label: 'A' }] }]];
  for (const questions of bad) {
    const ask = fakeAsk('allow');
    assert.equal(await reply(askInput(questions), privateEnv(), ask), undefined, JSON.stringify(questions));
    assert.equal(ask.calls.length, 0, JSON.stringify(questions));
  }
});

test('a secret in a question never reaches the decision log; each popup is logged', async () => {
  const env = privateEnv();
  await reply(askInput([question(`Rotate ${SECRET}?`, ['Yes', 'No']), FORMAT]), env, fakeAsk('timeout'));
  const logged = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8');
  assert.ok(!logged.includes(SECRET));
  assert.equal(logged.trim().split('\n').filter((line) => line.includes('AskUserQuestion')).length, 2);
});

/** A popup that stays open until its signal aborts, as a real one closes when the hook kills it; answers "closed" like answerAskAsync. */
const openUntilAborted = (onOpen) => async (request, _env, { signal }) => {
  onOpen(request);
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  return { decision: 'ask', outcome: 'closed', reason: 'closed' };
};

test('the asking marker shows while the popups are open and is cleared once they answered every question', async () => {
  const env = privateEnv();
  const seen = [];
  const ask = async () => {
    seen.push(readAsking(SESSION, env)?.kind);
    return { decision: 'allow', outcome: 'allow', reason: 'click' };
  };
  assert.equal((await reply(askInput([WATCHER, FORMAT]), env, ask)).behavior, 'allow');
  assert.deepEqual(seen, ['question', 'question']);
  assert.equal(readAsking(SESSION, env), null, 'nothing waits on the owner any more');
});

test('a question handed back to the terminal keeps its asking marker: the terminal question still waits', async () => {
  const env = privateEnv();
  assert.equal(await reply(askInput([WATCHER]), env, fakeAsk('deny')), undefined);
  assert.equal(readAsking(SESSION, env)?.kind, 'question');
});

test('a turn-down that lands as a popup ends is seen before the next popup opens', async () => {
  const transcriptPath = join(makeTempDir('question-transcript-'), 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } })}\n`);
    return { decision: 'allow', outcome: 'allow', reason: 'click' };
  };
  assert.equal(await reply({ ...askInput([WATCHER, FORMAT]), transcript_path: transcriptPath }, privateEnv(), ask, { pollMs: 60_000 }), undefined);
  assert.equal(calls.length, 1, 'question 2 never opens after the terminal turned the question down');
});

test('the owner turns the question down in the terminal (Chat about this, Esc): the open popup closes and no later one opens', async () => {
  const transcriptPath = join(makeTempDir('question-transcript-'), 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const opened = [];
  const ask = openUntilAborted((request) => {
    opened.push(request);
    appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } })}\n`);
  });
  assert.equal(await reply({ ...askInput([WATCHER, FORMAT]), transcript_path: transcriptPath }, privateEnv(), ask), undefined);
  assert.equal(opened.length, 1);
});

test('all popups fit inside the terminal question auto-continue: question 3 and 4 still get their own full wait', async () => {
  const ask = fakeAsk('timeout');
  const four = [WATCHER, FORMAT, SHIP, question('Last one?', ['A', 'B'])];
  await reply(askInput(four), privateEnv({ CLAUDE_QUESTION_TIMEOUT_S: '190' }), ask);
  const waits = ask.calls.map((call) => call.timeoutS);
  assert.equal(waits.length, 4);
  assert.ok(waits.every((wait) => wait === waits[0]), 'every question gets the same wait');
  assert.ok(waits.reduce((sum, wait) => sum + wait, 0) < TERMINAL_AUTO_CONTINUE_S, `${waits} must add up to less than ${TERMINAL_AUTO_CONTINUE_S} s`);
});

test('the default 2 min per question: 1 and 4 questions keep their full wait, 5 get 114 s and 6 get 95 s (all inside 10 min)', async () => {
  const single = fakeAsk('timeout');
  await reply(askInput([WATCHER]), privateEnv(), single);
  assert.deepEqual(single.calls.map((call) => call.timeoutS), [120]);
  const lastOne = question('Last one?', ['A', 'B']);
  const four = fakeAsk('timeout');
  await reply(askInput([WATCHER, FORMAT, SHIP, lastOne]), privateEnv(), four);
  assert.deepEqual(four.calls.map((call) => call.timeoutS), [120, 120, 120, 120]);
  const five = fakeAsk('timeout');
  await reply(askInput([WATCHER, FORMAT, SHIP, lastOne, question('Fifth?', ['A', 'B'])]), privateEnv(), five);
  assert.deepEqual(five.calls.map((call) => call.timeoutS), [114, 114, 114, 114, 114]);
  const six = fakeAsk('timeout');
  await reply(askInput([WATCHER, FORMAT, SHIP, lastOne, question('Fifth?', ['A', 'B']), question('Sixth?', ['A', 'B'])]), privateEnv(), six);
  assert.deepEqual(six.calls.map((call) => call.timeoutS), [95, 95, 95, 95, 95, 95]);
  const one = fakeAsk('timeout');
  await reply(askInput([WATCHER]), privateEnv({ CLAUDE_QUESTION_TIMEOUT_S: '190' }), one);
  assert.deepEqual(one.calls.map((call) => call.timeoutS), [190]);
});

test('settings/base.json askUserQuestionTimeout is the time the popups are planned inside (it auto-continues the terminal question)', () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../settings/base.json', import.meta.url)), 'utf8'));
  assert.equal(base.askUserQuestionTimeout, `${TERMINAL_AUTO_CONTINUE_S / 60}m`);
  assert.equal(base.env.CLAUDE_QUESTION_TIMEOUT_S, String(questionTimeoutSeconds({})), 'the installed wait is the code default (2 min)');
});

test('CLAUDE_QUESTION_TIMEOUT_S from the environment: too long is cut to 190 s, anything not a whole positive number gives 2 min, never 0', () => {
  const waits = ['9999', '-1', 'abc', '120.5', '0', '', undefined].map((value) => questionTimeoutSeconds({ CLAUDE_QUESTION_TIMEOUT_S: value }));
  assert.deepEqual(waits, [190, 120, 120, 120, 120, 120, 120]);
});

test('no questions: nothing is asked and nothing is divided by zero', async () => {
  const ask = fakeAsk('timeout');
  assert.equal(await reply(askInput([]), privateEnv(), ask), undefined);
  assert.equal(ask.calls.length, 0);
});

/** Starts the hook as a process with a hanging fake popup; returns the child and what it printed. */
function startHook(input, popup) {
  const child = spawn(process.execPath, [HOOK], { env: popup.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const done = new Promise((resolve) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout }));
  });
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}

/** Waits until `check()` is true or the limit passes; no fixed sleeps. */
async function until(check) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return check();
}

test('hook process: a turn-down in the terminal closes the real popup within the poll interval and the hook prints nothing', async () => {
  const popup = fakePopup('hang');
  const transcriptPath = join(makeTempDir('question-transcript-'), 'session.jsonl');
  writeFileSync(transcriptPath, '');
  const { done } = startHook({ ...askInput([WATCHER, FORMAT]), transcript_path: transcriptPath }, popup);
  assert.ok(await until(popup.alive), 'the popup opened');
  appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } })}\n`);
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(await until(() => !popup.alive()), 'the popup process is gone');
});

test('hook process: Claude Code stopping the hook (SIGTERM) takes the open popup with it', async () => {
  const popup = fakePopup('hang');
  const { child, done } = startHook(askInput([WATCHER]), popup);
  assert.ok(await until(popup.alive), 'the popup opened');
  child.kill('SIGTERM');
  await done;
  assert.ok(await until(() => !popup.alive()), 'the popup process is gone');
});

test('hook contract: an AskUserQuestion prompt with no GUI prints nothing and exits 0', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(askInput([WATCHER])), encoding: 'utf8', env: hookEnv(privateEnv()) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('hook process: three popups in a row, answered, print one allow line with all three answers', async () => {
  const popup = fakePopup('allow');
  const { done } = startHook(askInput([WATCHER, FORMAT, SHIP]), popup);
  const out = JSON.parse((await done).stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PermissionRequest');
  assert.equal(Object.keys(out.decision.updatedInput.answers).length, 3);
});
