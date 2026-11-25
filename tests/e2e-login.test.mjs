// Tests of where a live e2e run's login comes from (review round 3): resolveLogin takes the terminal's CLAUDE_CODE_OAUTH_TOKEN
// first, else the claude-account store's accountForCall, and reads no store with `--no-stored-login`; every line it returns
// names the account and the source, never the token, and a store error's text is redacted. useLogin hands the stored token to
// every child env and registers its exact value with the redactor, whatever its shape. No store, Keychain or `claude` is touched:
// the account module is a stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { madeUpToken } from './e2e-fixtures.mjs';
import { childEnv, LOGIN_ENV, useLogin } from './e2e/lib/env.mjs';
import { redact, REDACTED, redactJson } from './e2e/lib/redact.mjs';
import { NO_ACCOUNT_LINE, resolveLogin } from './e2e/lib/stored-login.mjs';

const ACCOUNT_NAME = 'e2e-made-up';
const STORE_TOKEN = madeUpToken('oat01');
const TERMINAL_TOKEN = madeUpToken('ort01');
const PLAIN_LOGIN = 'made-up-plain-login-value-0042'; // not sk-ant- shaped: only the registered-value mask can catch it
const OTHER_PLAIN_LOGIN = 'made-up-other-login-value-0043'; // registered by one test only
const SETUP_FROM = '/made-up/checkout';
const SPEC = { home: '/h', tmp: '/t', path: '/bin', quietLog: '/q', longRunState: '/l' };

/** A stub of the account module's loader: records each call and answers accountForCall with `answer` (a function may throw). */
function stubLoad(answer) {
  const calls = [];
  const load = async (setupFrom) => {
    calls.push(setupFrom);
    return { accountForCall: (env) => (typeof answer === 'function' ? answer(env) : answer) };
  };
  return { load, calls };
}

/** Runs `body` with LOGIN_ENV of the runner's env set to `value` (undefined: unset), then puts the old value back. */
function withTerminalToken(value, body) {
  const kept = process.env[LOGIN_ENV];
  try {
    if (value === undefined) delete process.env[LOGIN_ENV];
    else process.env[LOGIN_ENV] = value;
    return body();
  } finally {
    if (kept === undefined) delete process.env[LOGIN_ENV];
    else process.env[LOGIN_ENV] = kept;
  }
}

test('resolveLogin: the terminal token wins and no store is opened', async () => {
  const { load, calls } = stubLoad({ name: ACCOUNT_NAME, token: STORE_TOKEN });
  const found = await resolveLogin({ env: { [LOGIN_ENV]: TERMINAL_TOKEN }, setupFrom: SETUP_FROM, load });
  assert.deepEqual([found.ok, found.source, found.token, found.name], [true, 'env', TERMINAL_TOKEN, null]);
  assert.deepEqual(calls, [], 'the store is read only when the terminal has no token');
  assert.ok(!found.line.includes(TERMINAL_TOKEN));
});

test('resolveLogin: without a terminal token the stored account is used; its line names the account, never the token', async () => {
  const seen = [];
  const { load, calls } = stubLoad((env) => { seen.push(env); return { name: ACCOUNT_NAME, token: STORE_TOKEN }; });
  const env = { CLAUDE_ACCOUNT: ACCOUNT_NAME };
  const found = await resolveLogin({ env, setupFrom: SETUP_FROM, load });
  assert.deepEqual([found.ok, found.source, found.name, found.token], [true, 'store', ACCOUNT_NAME, STORE_TOKEN]);
  assert.equal(found.line, `login: stored account ${ACCOUNT_NAME}`);
  assert.deepEqual(calls, [SETUP_FROM], 'the account module of the checkout under test');
  assert.equal(seen[0], env, 'accountForCall gets the runner env (CLAUDE_ACCOUNT, else the default)');
});

test('resolveLogin: --no-stored-login reads no store and passes no token on', async () => {
  const { load, calls } = stubLoad({ name: ACCOUNT_NAME, token: STORE_TOKEN });
  const found = await resolveLogin({ env: {}, setupFrom: SETUP_FROM, useStore: false, load });
  assert.deepEqual([found.ok, found.source, found.token], [true, 'none', null]);
  assert.match(found.line, /--no-stored-login/);
  assert.deepEqual(calls, []);
});

test('resolveLogin: a store with no account for this call gives the plain no-account line', async () => {
  for (const answer of [null, { name: ACCOUNT_NAME, token: '' }]) {
    const found = await resolveLogin({ env: {}, setupFrom: SETUP_FROM, load: stubLoad(answer).load });
    assert.deepEqual([found.ok, found.line], [false, NO_ACCOUNT_LINE], JSON.stringify(answer));
    assert.equal(found.token, undefined, 'no token is handed on');
  }
});

test('resolveLogin: a locked or unreadable store gives the no-account line and a redacted error text', async () => {
  const locked = () => { throw new Error(`Keychain locked; last value ${STORE_TOKEN} and ${PLAIN_LOGIN}`); };
  const found = await resolveLogin({ env: {}, setupFrom: SETUP_FROM, load: stubLoad(locked).load });
  assert.deepEqual([found.ok, found.source, found.line], [false, 'store', NO_ACCOUNT_LINE]);
  assert.match(found.detail, /Keychain locked/);
  assert.ok(!found.detail.includes(STORE_TOKEN) && found.detail.includes(REDACTED), found.detail);
  const unloadable = await resolveLogin({ env: {}, setupFrom: SETUP_FROM, load: async () => { throw new Error('no module'); } });
  assert.deepEqual([unloadable.ok, unloadable.line], [false, NO_ACCOUNT_LINE]);
  assert.match(unloadable.detail, /no module/);
});

test('useLogin: the stored token reaches every child env; the terminal token still wins; null hands nothing on', () => {
  try {
    withTerminalToken(undefined, () => {
      useLogin(PLAIN_LOGIN);
      assert.equal(childEnv(SPEC)[LOGIN_ENV], PLAIN_LOGIN);
      assert.throws(() => childEnv({ ...SPEC, extra: { [LOGIN_ENV]: 'from-a-scenario' } }), /may not set/);
    });
    withTerminalToken(TERMINAL_TOKEN, () => assert.equal(childEnv(SPEC)[LOGIN_ENV], TERMINAL_TOKEN));
    withTerminalToken(undefined, () => {
      useLogin(null);
      assert.equal(LOGIN_ENV in childEnv(SPEC), false);
    });
  } finally {
    useLogin(null);
  }
});

test('useLogin: the stored token value is masked whatever its shape, in lines and results.json, and stays masked', () => {
  const value = OTHER_PLAIN_LOGIN;
  withTerminalToken(undefined, () => {
    assert.equal(redact(`token ${value}`), `token ${value}`, 'not masked before it is registered (the test proves the register)');
    useLogin(value);
    useLogin(null);
    const out = redact(`stderr: ${value} refused;again:${value}`);
    assert.equal(out, `stderr: ${REDACTED} refused;again:${REDACTED}`);
    assert.ok(!redactJson({ note: `x ${value}`, nested: [value] }).includes(value));
    assert.equal(redact(out), out);
  });
});
