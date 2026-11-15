// Tests for `recall --owner`: the owner's own typed messages of one session, oldest first, masked, one line each.
// Fixtures are synthetic; no real transcript is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { SESSION, j, run, setup } from './recall-helpers.mjs';

const at = (ts, message, extra = {}) => j({ type: 'user', timestamp: ts, message, ...extra });
const typed = (ts, text) => at(ts, { content: text });
const withSession = (env) => ({ ...env, CLAUDE_CODE_SESSION_ID: SESSION });
const owner = (env, ...args) => run(withSession(env), '--owner', ...args);
const lines = (stdout) => stdout.split('\n').filter(Boolean);

const TOKEN_SHAPED = 'q8Xz1Wv2Lp3Kd4Jf5Hg6Sa7Tb8Uc9Vd0';
const MIXED = [
  typed('2026-01-05T10:00:00Z', 'first owner point'),
  at('2026-01-05T10:01:00Z', { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output text' }] }),
  at('2026-01-05T10:02:00Z', { content: [{ type: 'text', text: 'second point with a picture' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }),
  typed('2026-01-05T10:03:00Z', '<system-reminder>hook says do things</system-reminder>'),
  typed('2026-01-05T10:04:00Z', '<task-notification>agent finished</task-notification>'),
  typed('2026-01-05T10:05:00Z', '<cross-session-message from="x">hello from another session</cross-session-message>'),
  at('2026-01-05T10:06:00Z', { content: 'This session is being continued from a previous conversation that ran out of context.' }),
  at('2026-01-05T10:06:30Z', { content: 'Summary text the harness made' }, { isCompactSummary: true }),
  at('2026-01-05T10:07:00Z', { content: [{ type: 'text', text: '<system-reminder>reminder before the words</system-reminder>' }, { type: 'text', text: 'third point after a reminder block' }] }),
  typed('2026-01-06T09:00:00Z', 'fourth point next day'),
];

test('--owner prints only the owner messages, oldest first, with index and time', async () => {
  const { env } = setup(MIXED);
  const result = await owner(env);
  assert.equal(result.status, 0, result.stderr);
  const out = lines(result.stdout);
  assert.equal(out.length, 4, result.stdout);
  assert.match(out[0], /^1\s+2026-01-05T10:00:00Z\s+first owner point$/);
  assert.match(out[1], /^2\s+2026-01-05T10:02:00Z\s+second point with a picture$/);
  assert.match(out[2], /^3\s+2026-01-05T10:07:00Z\s+third point after a reminder block$/);
  assert.match(out[3], /^4\s+2026-01-06T09:00:00Z\s+fourth point next day$/);
  assert.doesNotMatch(result.stdout, /tool output|hook says|agent finished|another session|continued from|Summary text|reminder before/);
});

test('--since keeps only messages from that date on', async () => {
  const { env } = setup(MIXED);
  const result = await owner(env, '--since', '2026-01-06');
  assert.deepEqual(lines(result.stdout).map((l) => l.replace(/\s+/g, ' ')), ['4 2026-01-06T09:00:00Z fourth point next day']);
});

test('--session takes an id; a missing session is an error', async () => {
  const { env } = setup(MIXED);
  const byId = await run(env, '--owner', '--session', SESSION);
  assert.equal(lines(byId.stdout).length, 4);
  const missing = await run(env, '--owner', '--session', 'ffffffff-no-such-session');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no session/);
});

test('credentials and token-shaped strings print masked, never the value', async () => {
  const { env } = setup([
    typed('2026-01-05T10:00:00Z', 'the login is password: hunter2 ok'),
    typed('2026-01-05T10:01:00Z', `use ${TOKEN_SHAPED} for the api`),
    typed('2026-01-05T10:02:00Z', 'creds: admin / s3cretvalue then go'),
    typed('2026-01-05T10:03:00Z', 'user/pass: bob/hunter3'),
  ]);
  const result = await owner(env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /hunter2|hunter3|s3cretvalue|q8Xz1Wv2Lp3Kd4Jf5Hg6Sa7Tb8Uc9Vd0/);
  assert.equal(lines(result.stdout).length, 4);
});

test('a 50,000-character message is masked first, then cut at 300 characters on one line', async () => {
  const long = `start password: hunter2 ${'word '.repeat(10000)}`;
  const { env } = setup([typed('2026-01-05T10:00:00Z', long), typed('2026-01-05T10:01:00Z', 'after')]);
  const result = await owner(env);
  const out = lines(result.stdout);
  assert.equal(out.length, 2);
  assert.doesNotMatch(out[0], /hunter2/);
  const text = out[0].split(/\s+/).slice(2).join(' ');
  assert.ok(text.length <= 301, `text is ${text.length} chars`);
  assert.match(text, /^start /);
});

test('an empty session prints nothing and exits 0', async () => {
  const { env } = setup([]);
  const result = await owner(env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a large transcript is read line by line and answers in seconds', async () => {
  const filler = j({ type: 'assistant', timestamp: '2026-01-05T10:00:00Z', message: { id: 'm', content: [{ type: 'text', text: 'x'.repeat(2000) }] } });
  const { env, file } = setup([]);
  writeFileSync(file, `${typed('2026-01-05T09:00:00Z', 'first')}${filler.repeat(8000)}${typed('2026-01-05T11:00:00Z', 'last')}`);
  const started = Date.now();
  const result = await owner(env);
  assert.deepEqual(lines(result.stdout).map((l) => l.split(/\s+/).at(-1)), ['first', 'last']);
  assert.ok(Date.now() - started < 10000);
});

test('--owner without a session id says so', async () => {
  const { env } = setup(MIXED);
  const withoutId = { ...env };
  delete withoutId.CLAUDE_CODE_SESSION_ID;
  const result = await run(withoutId, '--owner');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLAUDE_CODE_SESSION_ID/);
});
