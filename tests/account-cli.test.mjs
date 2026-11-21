// Tests for the command `home/tools/account/account.mjs` (what the shell function `claude-account` runs): add from a
// pasted line on stdin, the validity check through the fake `claude`, list, remove, check, default, plan, credits-off,
// and the one command that prints a token (`token`, and `once` for an unsaved paste), which refuses a terminal and a
// Claude session. Every run gets a temp HOME and TMPDIR and the file store; K10: after each test a scan of the sandbox
// finds the token only in the store, and no stdout, stderr, log or argument list holds it except `token` to a pipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry } from '../home/tools/account/lib/registry.mjs';
import { PTY_PLATFORM, accountSandbox, assertNoLeak, fakeToken, filesHolding, runInPty, tokenHash } from './account-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/account/account.mjs', import.meta.url));
const TOKEN_A = fakeToken('CliA');
const TOKEN_B = fakeToken('CliB');
const EXIT = { ok: 0, refused: 1, usage: 2, unknown: 3, output: 4 };

function sandbox(t, options) {
  const box = accountSandbox(options);
  t.after(() => assertNoLeak(box, [TOKEN_A, TOKEN_B]));
  return box;
}

/** Runs the command with `input` on stdin (a pipe, as the shell function gives it). */
const account = (box, args, { input = '', env = {} } = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...box.env, ...env }, input, encoding: 'utf8' });
const usageRows = (box) => readFileSync(join(box.env.RECALL_STATE_DIR, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const shown = (run) => `${run.stdout}${run.stderr}`;

test('add: the pasted export line is accepted, checked with one Haiku call on that token, stored, and never printed', (t) => {
  const box = sandbox(t);
  const run = account(box, ['add', 'work'], { input: `export CLAUDE_CODE_OAUTH_TOKEN="${TOKEN_A}"\n` });
  assert.equal(run.status, EXIT.ok, run.stderr);
  assert.ok(!shown(run).includes(TOKEN_A));
  assert.match(run.stdout, /added account work: valid/);
  assert.deepEqual(filesHolding(box.dir, TOKEN_A), [join(box.storeDir, 'work.token')]);
  const calls = box.claudeCalls();
  assert.deepEqual([calls.length, calls[0].tokenHash], [1, tokenHash(TOKEN_A)]);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'haiku', 'K13: the check names Haiku');
  assert.ok(!calls[0].args.includes('--bare') && !calls[0].args.some((arg) => arg.includes(TOKEN_A)));
  assert.deepEqual([usageRows(box)[0].account, usageRows(box)[0].label], ['work', 'account-check']);
  assert.equal(readRegistry(box.env).accounts.work.checked.result, 'valid');
});

test('add: a revoked token is refused with a clear message and nothing is stored', (t) => {
  const box = sandbox(t, { claudeMode: 'revoked' });
  const run = account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  assert.equal(run.status, EXIT.refused);
  assert.match(run.stderr, /refused.*revoked|revoked.*refused/s);
  assert.match(run.stderr, /Nothing was stored/);
  assert.ok(!shown(run).includes(TOKEN_A));
  assert.deepEqual(filesHolding(box.dir, TOKEN_A), []);
  assert.deepEqual(readRegistry(box.env).accounts, {});
});

test('add: a check that fails for another reason (a usage limit) stores the token and says the check failed, with its class', (t) => {
  const box = sandbox(t, { claudeMode: 'limit' });
  const run = account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  assert.equal(run.status, EXIT.ok, run.stderr);
  assert.match(run.stdout, /^added account work, NOT verified \(limit\); run claude-account check work later$/m);
  assert.equal(box.claudeCalls().length, 1, 'one call, no second attempt');
});

test('add: text that is not a token, a hostile name, a token as an argument, a terminal-less Claude session: each refused before any call', (t) => {
  const box = sandbox(t);
  for (const [args, options, status] of [
    [['add', 'work'], { input: 'hello\n' }, EXIT.refused],
    [['add', 'work'], { input: `${TOKEN_A}\n${TOKEN_B}\n` }, EXIT.refused],
    [['add', 'work'], { input: `${TOKEN_A}${'x'.repeat(5000)}\n` }, EXIT.refused],
    [['add', '../x'], { input: `${TOKEN_A}\n` }, EXIT.usage],
    [['add', 'a"b'], { input: `${TOKEN_A}\n` }, EXIT.usage],
    [['add', 'a\nb'], { input: `${TOKEN_A}\n` }, EXIT.usage],
    [['add'], { input: `${TOKEN_A}\n` }, EXIT.usage],
    [['add', 'work', TOKEN_A], {}, EXIT.usage],
    [['add', TOKEN_A], {}, EXIT.usage],
    [['add', 'work'], { input: `${TOKEN_A}\n`, env: { CLAUDECODE: '1' } }, EXIT.output],
  ]) {
    const run = account(box, args, options);
    assert.equal(run.status, status, `${JSON.stringify(args.map((arg) => arg.slice(0, 12)))}: ${run.stderr.slice(0, 200)}`);
    assert.ok(!shown(run).includes('MadeUp'), 'the refusal names no part of the token');
  }
  for (const args of [['add', 'work', TOKEN_A], ['token', TOKEN_A], ['remove', `x${TOKEN_A}`]]) assert.match(account(box, args).stderr, /looks like a token: a token is never an argument/);
  assert.deepEqual(box.claudeCalls(), []);
  assert.ok(!existsSync(join(box.storeDir, 'work.token')));
});

test('token: prints the stored token to a pipe and nothing else; an unknown account is exit 3; a Claude session is refused', (t) => {
  const box = sandbox(t);
  assert.equal(account(box, ['add', 'work'], { input: `${TOKEN_A}\n` }).status, EXIT.ok);
  const run = account(box, ['token', 'work']);
  assert.deepEqual([run.status, run.stdout, run.stderr], [EXIT.ok, `${TOKEN_A}\n`, '']);
  assert.equal(account(box, ['token', 'nobody']).status, EXIT.unknown);
  const inClaude = account(box, ['token', 'work'], { env: { CLAUDECODE: '1' } });
  assert.equal(inClaude.status, EXIT.output);
  assert.ok(!shown(inClaude).includes(TOKEN_A));
  assert.match(inClaude.stderr, /Claude session/);
});

if (PTY_PLATFORM) {
  test('token and once refuse a terminal as output: the token is never shown on the screen', async (t) => {
    const box = sandbox(t);
    assert.equal(account(box, ['add', 'work'], { input: `${TOKEN_A}\n` }).status, EXIT.ok);
    const run = await runInPty([process.execPath, CLI, 'token', 'work'], { env: box.env });
    assert.ok(!run.output.includes(TOKEN_A));
    assert.match(run.output, /terminal/);
    assert.equal(run.code, EXIT.output);
  });
}

test('once: a pasted line is checked and handed back on a pipe, and nothing is stored', (t) => {
  const box = sandbox(t);
  const run = account(box, ['once'], { input: `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_B}\n` });
  assert.deepEqual([run.status, run.stdout], [EXIT.ok, `${TOKEN_B}\n`]);
  assert.deepEqual(filesHolding(box.dir, TOKEN_B), []);
  assert.equal(usageRows(box)[0].account, null, 'an unsaved token has no account name');
  const revoked = sandbox(t, { claudeMode: 'revoked' });
  const refused = account(revoked, ['once'], { input: `${TOKEN_B}\n` });
  assert.deepEqual([refused.status, refused.stdout], [EXIT.refused, '']);
});

test('list: per account this terminal or not, the added date, days left, valid or revoked, plan and usage credits; names only, never a token', (t) => {
  const box = sandbox(t);
  assert.match(account(box, ['list']).stdout, /no accounts stored/);
  account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  account(box, ['add', 'home'], { input: `${TOKEN_B}\n` });
  assert.equal(account(box, ['plan', 'work', 'max']).status, EXIT.ok);
  assert.equal(account(box, ['credits-off', 'work']).status, EXIT.ok);
  const run = account(box, ['list'], { env: { CLAUDE_ACCOUNT: 'work', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A } });
  const [home, work] = run.stdout.trim().split('\n');
  assert.match(work, /^work\b.*this terminal.*added \d{4}-\d{2}-\d{2}.*36[45] days left.*valid.*plan max.*usage credits: off/);
  assert.match(home, /^home\b.*plan unknown.*usage credits: not confirmed off/);
  assert.ok(!/this terminal/.test(home));
  assert.ok(!shown(run).includes('MadeUp'));
  assert.deepEqual(account(box, ['names']).stdout, 'home\nwork\n');
});

test('default, plan and credits-off: recorded for a stored account, refused for an unknown one or a bad value', (t) => {
  const box = sandbox(t);
  account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  assert.equal(account(box, ['default', 'work']).status, EXIT.ok);
  assert.equal(readRegistry(box.env).default, 'work');
  assert.equal(account(box, ['default']).stdout, 'work\n', 'with no name it prints the default');
  assert.match(account(box, ['list']).stdout, /default/);
  assert.equal(account(box, ['default', 'none']).status, EXIT.ok);
  assert.equal(readRegistry(box.env).default, null);
  for (const args of [['default', 'nobody'], ['plan', 'nobody', 'max'], ['credits-off', 'nobody']]) assert.equal(account(box, args).status, EXIT.unknown, args.join(' '));
  for (const args of [['plan', 'work', 'free'], ['plan', 'work'], ['default', 'a', 'b'], ['nonsense'], []]) assert.equal(account(box, args).status, EXIT.usage, args.join(' '));
});

test('check: one Haiku call per account on its own token; a revoked account is reported, recorded and exits 1', (t) => {
  const box = sandbox(t);
  account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  account(box, ['add', 'home'], { input: `${TOKEN_B}\n` });
  const all = account(box, ['check']);
  assert.deepEqual([all.status, all.stdout], [EXIT.ok, 'home: valid\nwork: valid\n']);
  assert.deepEqual(box.claudeCalls().slice(2).map((call) => call.tokenHash), [tokenHash(TOKEN_B), tokenHash(TOKEN_A)]);
  const revoked = account(box, ['check', 'work'], { env: { FAKE_CLAUDE_MODE: 'revoked' } });
  assert.deepEqual([revoked.status, revoked.stdout], [EXIT.refused, 'work: revoked\n']);
  assert.equal(readRegistry(box.env).accounts.work.checked.result, 'revoked');
  assert.match(account(box, ['list']).stdout, /^work\b.*revoked/m);
  assert.equal(account(box, ['check', 'nobody']).status, EXIT.unknown);
  assert.ok(box.claudeCalls().every((call) => call.args[call.args.indexOf('--model') + 1] === 'haiku' && !call.args.includes('--bare')), 'K13 keep: every check call names Haiku and never --bare');
});

test('remove: the token and its fields are gone; a second remove says there is no such account', (t) => {
  const box = sandbox(t);
  account(box, ['add', 'work'], { input: `${TOKEN_A}\n` });
  assert.equal(account(box, ['remove', 'work']).status, EXIT.ok);
  assert.deepEqual(filesHolding(box.dir, TOKEN_A), []);
  assert.deepEqual(readRegistry(box.env).accounts, {});
  assert.equal(account(box, ['remove', 'work']).status, EXIT.unknown);
});
