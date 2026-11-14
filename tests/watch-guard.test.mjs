// Tests for home/tools/watch/lib/guard.mjs: which guard-log lines reach the watcher's stdout, and how they are printed.
// Synthetic guard lines; the secret-looking value is built at run time so no literal secret sits in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardAction } from '../home/tools/watch/lib/guard.mjs';

const WATCHED = new Map([['aaaaaaaa-1111-2222-3333-444444444444', 'aaaaaaaa']]);
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
const SECRET_REASON = 'the command contains a literal password/token (an API key); prefer an env var or a file the tool reads';
const guardLine = (over) => JSON.stringify({ ts: '2026-11-14T12:00:00.000Z', hook: 'pre-bash-guard', tool: 'Bash', decision: 'ask', outcome: 'timeout', reason: 'DESTRUCTIVE: rm -rf', command: 'rm -rf build', cwd: '/x', session: 'aaaaaaaa-1111-2222-3333-444444444444', ...over });

test('a timeout for a watched session is printed with reason and a short command', () => {
  const text = guardAction(guardLine({}), WATCHED);
  assert.equal(text, 'aaaaaaaa: GUARD timeout pre-bash-guard: DESTRUCTIVE: rm -rf | rm -rf build');
});

test('deny, no-gui and dialog-failed are printed; allow, remembered and unknown outcomes are not', () => {
  for (const outcome of ['deny', 'no-gui', 'dialog-failed']) assert.match(guardAction(guardLine({ outcome }), WATCHED), new RegExp(`GUARD ${outcome} `));
  for (const outcome of ['allow', 'remembered', 'weird']) assert.equal(guardAction(guardLine({ outcome }), WATCHED), undefined, outcome);
});

test('another session is skipped, as is a line with no session', () => {
  assert.equal(guardAction(guardLine({ session: OTHER }), WATCHED), undefined);
  assert.equal(guardAction(guardLine({ session: undefined }), WATCHED), undefined);
});

test('a secret-ask timeout is skipped but a secret-ask deny is printed', () => {
  assert.equal(guardAction(guardLine({ reason: SECRET_REASON }), WATCHED), undefined);
  assert.equal(guardAction(guardLine({ reason: SECRET_REASON, outcome: 'no-gui' }), WATCHED), undefined);
  assert.match(guardAction(guardLine({ reason: SECRET_REASON, outcome: 'deny' }), WATCHED), /GUARD deny /);
});

test('the command is masked before it is cut to 60 characters, and never printed whole', () => {
  const token = `ghp_${'a1B2c3D4'.repeat(5)}`;
  const command = `curl -H "Authorization: Bearer ${token}" ${'y'.repeat(200)}`;
  const text = guardAction(guardLine({ command }), WATCHED);
  assert.ok(!text.includes(token), 'the token must not appear');
  assert.ok(!text.includes('y'.repeat(61)), 'the command is cut');
  assert.match(text, /\[masked\]/);
});

test('control characters and newlines in the command or reason never split the output line', () => {
  const text = guardAction(guardLine({ command: 'echo a\nrm -rf x\r\u001b[31m', reason: 'two\nlines' }), WATCHED);
  assert.ok(!/[\n\r\u001b]/.test(text));
});

test('malformed JSON and non-objects are ignored', () => {
  for (const raw of ['', 'nope', '{"outcome":', '7', 'null']) assert.equal(guardAction(raw, WATCHED), undefined, raw);
});
