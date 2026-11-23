// Unit tests for lib/remembered-ask.mjs (bounce once, else the owner; a literal secret only logged by kind, owner G1) and for the
// secret-reason wording of lib/verdict.mjs, which no guard rule gives any more.
import assert from 'node:assert/strict';
import './pin-home.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { secretAskTimeoutSeconds } from '../home/hooks/lib/timed-ask.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { askOrBounce, logSecretKind, SECRET_OUTCOME } from '../home/hooks/lib/remembered-ask.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { isSecretOnlyReason, secretReason } from '../home/hooks/lib/verdict.mjs';

const MARK = ' (matched in raw text)';
const LONG_VALUE = 'abcdefghij1234';

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

test('logSecretKind (owner G1): one log line, outcome "secret", the kind as its reason, no command and no value', () => {
  const env = { CLAUDE_GUARD_LOG: join(makeTempDir('remembered-ask-'), 'guard.jsonl') };
  logSecretKind('a GitHub token', { cwd: '/work/proj', input: { session_id: 'sess-1' } }, env);
  const lines = readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ ts, ...line }) => line), [{ hook: 'pre-bash-guard', tool: 'Bash', decision: 'allow', outcome: SECRET_OUTCOME,
    class: 'secret', reason: 'a GitHub token', command: '', cwd: '/work/proj', session: 'sess-1' }]);
});

test('secretAskTimeoutSeconds: 120 by default, its own env, never above the normal ask timeout, bad values fall back', () => {
  assert.equal(secretAskTimeoutSeconds({}), 120);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_SECRET_TIMEOUT_S: '7' }), 7);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '10' }), 10);
  assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_TIMEOUT_S: '10', CLAUDE_ASK_SECRET_TIMEOUT_S: '99' }), 10);
  for (const bad of ['0', '-1', 'abc', '']) assert.equal(secretAskTimeoutSeconds({ CLAUDE_ASK_SECRET_TIMEOUT_S: bad }), 120, bad);
});

test('decide (owner G1): a literal secret is no reason, and never hides the hidden-risk backstop', () => {
  const ctx = { cwd: '/work/proj', project: '/work/proj' };
  const plain = decide(`KEY='${LONG_VALUE}' ./run`, ctx);
  assert.deepEqual(plain, { allow: true, secret: 'a key, token, secret or password assigned in the command' });
  const hidden = decide(`KEY='${LONG_VALUE}'; python3 -c "import os;os.system('git push -f')"`, ctx);
  assert.deepEqual([hidden.ask, hidden.reasons, typeof hidden.secret], [true, ['risky word inside shell expansion'], 'string']);
  assert.equal(isSecretOnlyReason(hidden.reason), false);
});

test('askOrBounce: an ask with a bounce class is denied once, its identical retry and any other ask reach the owner (the CLI ask with no GUI)', () => {
  const home = makeTempDir('remembered-ask-home-');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl'), SSH_CONNECTION: 'test' }; // no GUI: the CLI ask, never a real dialog
  const ctx = { cwd: '/work/proj', project: '/work/proj' };
  const answer = (command) => JSON.parse(askOrBounce(decide(command, ctx), { command, cwd: '/work/proj', input: { session_id: 'sess-1' } }, env)).hookSpecificOutput;
  assert.equal(answer('read X; git $X').permissionDecision, 'deny');
  assert.equal(answer('read X; git $X').permissionDecision, 'ask');
  assert.equal(answer('git push origin main').permissionDecision, 'ask');
});
