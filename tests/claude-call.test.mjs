// Tests for the login of the hook child (`callHaiku` in home/tools/recall/lib/claude-call.mjs), spec-accounts K1, K2, K13:
// which account's token the `claude -p` child gets, that no child starts without one (a stored login is never spent),
// that an auth or usage-limit error never leads to a call on another account, and that the usage row names the account.
// The child is the fake `claude` of recall-fakes.mjs, patched to log a hash of its token; the store is in memory.
// (`claudePlan` and the billing variables are tested in tests/recall-checkpoint.test.mjs, not again here.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callHaiku } from '../home/tools/recall/lib/claude-call.mjs';
import { accountSandbox, assertNoLeak, fakeToken, memoryStore, tokenHash } from './account-helpers.mjs';

const TOKEN_A = fakeToken('AccountA');
const TOKEN_B = fakeToken('AccountB');
const TOKEN_ENV = fakeToken('Terminal');
const CALL = { system: 'Reply with the single word ok.', prompt: 'ok', label: 'test' };

const usageRows = (box) => {
  try {
    return readFileSync(join(box.env.RECALL_STATE_DIR, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

/** A sandbox whose leak scan runs when the test ends. */
function sandbox(t, options) {
  const box = accountSandbox(options);
  t.after(() => assertNoLeak(box, [TOKEN_A, TOKEN_B, TOKEN_ENV]));
  return box;
}

test('K1: no token in the environment and no account: no child is started, one auth row is written, the error has kind auth', async (t) => {
  const box = sandbox(t);
  const store = memoryStore({ a: TOKEN_A });
  await assert.rejects(callHaiku({ ...CALL, env: box.env, store }), (error) => error.kind === 'auth');
  assert.deepEqual(box.claudeCalls(), [], 'the fake claude was never started');
  const rows = usageRows(box);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].error, rows[0].is_error], [null, 'auth', true]);
  assert.deepEqual(store.reads, [], 'no account is read when none is named and no default is set');
});

test('K2: with accounts a and b stored and CLAUDE_ACCOUNT=a, the child is started once with the token of a, and the row names a', async (t) => {
  const box = sandbox(t);
  const store = memoryStore({ a: TOKEN_A, b: TOKEN_B });
  const reply = await callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: 'a' }, store });
  assert.ok(reply.text.length > 0);
  const calls = box.claudeCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokenHash, tokenHash(TOKEN_A));
  assert.deepEqual(store.reads, ['a'], 'the other account is never read');
  const rows = usageRows(box);
  assert.deepEqual([rows.length, rows[0].account, rows[0].is_error], [1, 'a', false]);
});

for (const mode of ['revoked', 'limit']) {
  test(`K2 keep: when the account answers with ${mode === 'revoked' ? 'an auth error' : 'a usage-limit error'}, the call throws and no other account gets a call`, async (t) => {
    const box = sandbox(t, { claudeMode: mode });
    const store = memoryStore({ a: TOKEN_A, b: TOKEN_B });
    await assert.rejects(callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: 'a' }, store }), /claude reported an error/);
    const calls = box.claudeCalls();
    assert.equal(calls.length, 1, 'exactly one start');
    assert.notEqual(calls[0].tokenHash, tokenHash(TOKEN_B));
    assert.ok(!store.reads.includes('b'));
  });
}

test('with no CLAUDE_ACCOUNT the default account is used, and the row names it', async (t) => {
  const box = sandbox(t);
  const { addAccount, setDefault } = await import('../home/tools/account/lib/accounts.mjs');
  const store = memoryStore();
  addAccount('a', TOKEN_A, { env: box.env, store });
  addAccount('b', TOKEN_B, { env: box.env, store });
  setDefault('b', { env: box.env });
  await callHaiku({ ...CALL, env: box.env, store });
  const calls = box.claudeCalls();
  assert.deepEqual([calls.length, calls[0].tokenHash], [1, tokenHash(TOKEN_B)]);
  assert.equal(usageRows(box)[0].account, 'b');
});

test('K12: CLAUDE_ACCOUNT=- (a claude-as --once terminal) never spends the default account: no child, one auth row', async (t) => {
  const box = sandbox(t);
  const { addAccount, setDefault } = await import('../home/tools/account/lib/accounts.mjs');
  const store = memoryStore();
  addAccount('b', TOKEN_B, { env: box.env, store });
  setDefault('b', { env: box.env });
  await assert.rejects(callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: '-' }, store }), (error) => error.kind === 'auth');
  assert.deepEqual(box.claudeCalls(), []);
  assert.equal(usageRows(box)[0].error, 'auth');
});

test('a CLAUDE_ACCOUNT that names no stored account never falls back to the default: no child', async (t) => {
  const box = sandbox(t);
  const { addAccount, setDefault } = await import('../home/tools/account/lib/accounts.mjs');
  const store = memoryStore();
  addAccount('b', TOKEN_B, { env: box.env, store });
  setDefault('b', { env: box.env });
  await assert.rejects(callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: 'gone' }, store }), (error) => error.kind === 'auth');
  assert.deepEqual(box.claudeCalls(), []);
});

for (const hostile of ['../x', 'a"b', 'a\nb', '-rf', 'A']) {
  test(`a hostile CLAUDE_ACCOUNT (${JSON.stringify(hostile)}) reaches no store call and starts no child`, async (t) => {
    const box = sandbox(t);
    const store = memoryStore({ a: TOKEN_A });
    await assert.rejects(callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: hostile }, store }), (error) => error.kind === 'auth');
    assert.deepEqual(store.reads, []);
    assert.deepEqual(box.claudeCalls(), []);
  });
}

test("a token in the terminal's environment is used as it is: the store is not read, and the row names CLAUDE_ACCOUNT", async (t) => {
  const box = sandbox(t);
  const store = memoryStore({ a: TOKEN_A });
  await callHaiku({ ...CALL, env: { ...box.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ENV, CLAUDE_ACCOUNT: 'a' }, store });
  assert.equal(box.claudeCalls()[0].tokenHash, tokenHash(TOKEN_ENV));
  assert.deepEqual(store.reads, []);
  assert.equal(usageRows(box)[0].account, 'a');
});

test('K13: an account passed by the caller (the check of `claude-account add` and `check`) wins over the environment', async (t) => {
  const box = sandbox(t);
  const store = memoryStore({ a: TOKEN_A });
  await callHaiku({ ...CALL, env: { ...box.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ENV, CLAUDE_ACCOUNT: 'a' }, store, account: { name: 'b', token: TOKEN_B } });
  assert.equal(box.claudeCalls()[0].tokenHash, tokenHash(TOKEN_B));
  assert.equal(usageRows(box)[0].account, 'b');
});

test('keep: a call on a stored account names a model that is not Fable (--model haiku), never --bare, and no argument or usage row holds the token', async (t) => {
  const box = sandbox(t);
  const store = memoryStore({ a: TOKEN_A });
  await callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: 'a' }, store });
  const { args } = box.claudeCalls()[0];
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.some((arg) => arg.includes(TOKEN_A)));
  assert.ok(!JSON.stringify(usageRows(box)).includes(TOKEN_A));
});

test('a child that prints its token and dies: the error that is thrown holds no part of the token', async (t) => {
  const box = sandbox(t, { claudeMode: 'leak' });
  const store = memoryStore({ a: TOKEN_A });
  await assert.rejects(callHaiku({ ...CALL, env: { ...box.env, CLAUDE_ACCOUNT: 'a' }, store }), (error) => {
    assert.match(error.message, /without JSON/);
    assert.ok(!error.message.includes(TOKEN_A), 'the token is cut out of the error text');
    return true;
  });
});
