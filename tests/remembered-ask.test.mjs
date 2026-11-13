// Unit tests for lib/remembered-ask.mjs: which ask reasons count as "secret only", and how remembered values are neutralised.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretAskTimeoutSeconds } from '../home/hooks/lib/timed-ask.mjs';
import { isSecretOnlyReason, neutralise, REMEMBERED_ENV_REF, secretReason } from '../home/hooks/lib/remembered-ask.mjs';

const MARK = ' (matched in raw text)';

test('isSecretOnlyReason: plain, two-secret and backstop forms are secret-only', () => {
  assert.equal(isSecretOnlyReason(secretReason('a GitHub token')), true);
  assert.equal(isSecretOnlyReason(`${secretReason('a GitHub token')}; ${secretReason('a bearer token')}`), true);
  assert.equal(isSecretOnlyReason(`${secretReason('a GitHub token')}${MARK}`), true);
  assert.equal(isSecretOnlyReason(`${secretReason('a GitHub token')}; ${secretReason('a bearer token')}${MARK}`), true);
});

test('isSecretOnlyReason: any other reason, mixed or alone, is not', () => {
  const secret = secretReason('a GitHub token');
  const push = 'git push publishes commits to a remote; confirm with the owner';
  assert.equal(isSecretOnlyReason(`${secret}; ${push}`), false);
  assert.equal(isSecretOnlyReason(`${push}; ${secret}`), false);
  assert.equal(isSecretOnlyReason(`${secret}; DESTRUCTIVE: rm -r outside the project`), false);
  assert.equal(isSecretOnlyReason(push), false);
  assert.equal(isSecretOnlyReason('guard error'), false);
  assert.equal(isSecretOnlyReason(''), false);
});

test('neutralise: every occurrence of each value becomes the env reference, longest value first', () => {
  const text = neutralise('A=longer-value-12 B=longer-value-12 C=longer-value', ['longer-value', 'longer-value-12']);
  assert.equal(text, `A=${REMEMBERED_ENV_REF} B=${REMEMBERED_ENV_REF} C=${REMEMBERED_ENV_REF}`);
  assert.equal(neutralise('nothing here', ['absent-value']), 'nothing here');
});

test('secretAskTimeoutSeconds: 30 by default, its own env, never above the normal ask timeout, bad values fall back', () => {
  assert.equal(secretAskTimeoutSeconds({}), 30);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_SECRET_TIMEOUT_S: '7' }), 7);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '10' }), 10);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '10', CLAUDE_ASK_SECRET_TIMEOUT_S: '99' }), 10);
  for (const bad of ['0', '-1', 'abc', '']) assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_SECRET_TIMEOUT_S: bad }), 30, bad);
});
