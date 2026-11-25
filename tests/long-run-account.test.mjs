// Tests of the account a run spends and of its secrets (spec 7.5, 15; acceptance 9, 10): the selected account is recorded and
// kept on every resume until `resume --account` switches it, unusable accounts are refused with the fix named, Fable is refused,
// and no token or ntfy topic reaches the state folder, a usage row or an argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../home/tools/long-run/lib/run-store.mjs';
import { notify, readNotifyConfig, setupNtfy } from '../home/tools/long-run/lib/notify.mjs';
import { TOKEN_A, cli, createRun, driveRun, makeSandbox, readCalls } from './long-run-helpers.mjs';

const hash = (token) => createHash('sha256').update(token).digest('hex');
const oneStep = (box, extra = {}) => box.writeJob({ name: 'acct', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }], ...extra });

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((path) => statSync(path).isFile());
}

const holding = (dirs, text) => dirs.flatMap(filesUnder).filter((path) => readFileSync(path).includes(text));

test('the account selected at start is recorded; a resume from a terminal on account acct-b still runs with the token of acct-a', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked', 'done'] });
  const started = cli(box, ['start', oneStep(box), '--foreground']);
  assert.equal(started.status, 0, started.stderr);
  const runId = /^started (\S+)/m.exec(started.stdout)[1];
  assert.equal(readJson(join(box.root, runId, 'run.json')).account, 'acct-a');
  const resumed = cli(box, ['resume', runId, '--retry', '--foreground'], { env: { ...box.env, CLAUDE_ACCOUNT: 'acct-b' } });
  assert.equal(resumed.status, 0, resumed.stderr);
  const calls = readCalls(box);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual([call.account, call.tokenHash], ['acct-a', hash(TOKEN_A)]);
});

test('refusals exit 1 and name the fix: a one-time token, an unknown name, no account and no default, credits not recorded off', () => {
  const box = makeSandbox({ creditsOff: { 'acct-a': true, 'acct-b': false } });
  const job = oneStep(box);
  const cases = [
    [{ CLAUDE_ACCOUNT: '-' }, /one-time token .* claude-as <name>/],
    [{ CLAUDE_ACCOUNT: 'zed' }, /account zed is gone from the store .* claude-as zed/],
    [{ CLAUDE_ACCOUNT: '' }, /no account selected and no default: pick an account first: claude-as <name>/],
    [{ CLAUDE_ACCOUNT: 'acct-b' }, /record that usage credits are off for this account first: claude-account credits-off acct-b/],
  ];
  for (const [env, message] of cases) {
    for (const command of ['check', 'start']) {
      const result = cli(box, [command, job], { env: { ...box.env, ...env } });
      assert.equal(result.status, 1, `${command} ${JSON.stringify(env)}`);
      assert.match(result.stderr, message);
    }
  }
  assert.deepEqual(readCalls(box), [], 'no claude was started');
});

test('a run whose account lost "credits off" is held at its next start, never spent', async () => {
  const box = makeSandbox({ creditsOff: { 'acct-a': false, 'acct-b': true } });
  const paths = createRun(box, { name: 'lost', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  assert.equal(await driveRun(box, paths), 'held');
  assert.match(readJson(paths.driver).hold.reason, /claude-account credits-off acct-a/);
  assert.deepEqual(readCalls(box), []);
});

test('model fable or claude-fable-* exits 1; no model puts claude-opus-5-5 in the argv', () => {
  const box = makeSandbox();
  for (const model of ['fable', 'claude-fable-5-0']) {
    const result = cli(box, ['start', oneStep(box, { model })]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Fable is never used/);
  }
  assert.equal(cli(box, ['start', oneStep(box), '--foreground']).status, 0);
  const [call] = readCalls(box);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-opus-5-5');
});

test('secrets: a token the child prints on stdout and stderr is in no file of the state or usage folders and in no argv; the ntfy topic is in no log or event', async () => {
  const box = makeSandbox();
  box.script({ one: ['leak'] });
  setupNtfy({ env: box.env });
  const { topic } = readNotifyConfig(box.env).ntfy;
  const paths = createRun(box, { name: 'leak', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  const failingFetch = async (url) => { throw new Error(`connect failed to ${url}`); };
  const spawnStub = () => ({ once: (event, done) => { if (event === 'close') setImmediate(() => done(0)); } });
  await driveRun(box, paths, { notifier: (texts, options) => notify(texts, { ...options, fetchFn: failingFetch, spawnFn: spawnStub }) });
  assert.ok(readFileSync(paths.events, 'utf8').includes('phone push failed: Error'), 'the failed push is one events.jsonl line');
  const failures = await notify({ desktop: 'x', phone: 'y' }, { env: box.env, fetchFn: failingFetch, spawnFn: spawnStub });
  assert.deepEqual(failures, ['phone push failed: Error']);
  const scanned = [box.root, box.folders['account-state']];
  assert.ok(filesUnder(box.root).some((path) => path.endsWith('one.1.jsonl')), 'the step log exists');
  assert.deepEqual(holding(scanned, 'sk-ant-'), [], 'no token-shaped text in the state or usage files');
  assert.ok(readFileSync(join(paths.logs, 'one.1.jsonl'), 'utf8').includes('my token is <token>'));
  assert.ok(readFileSync(join(paths.logs, 'one.1.stderr.log'), 'utf8').includes('debug token <token>'));
  for (const call of readCalls(box)) assert.ok(!call.args.join(' ').includes('sk-ant-'));
  assert.deepEqual(holding(scanned, topic), [], 'the ntfy topic is in no log or event');
});
