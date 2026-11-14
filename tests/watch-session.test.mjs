// Tests for home/tools/watch/lib/watcher.mjs and subagents.mjs: a session watcher on real temp files with an injected clock.
// Covers stall -> RESUMED, partial last line, subagent model mismatch, SESSION_END, and the guard follower for watched sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuardFollower, createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { isModelMismatch } from '../home/tools/watch/lib/subagents.mjs';

const MIN = 60_000;
const SESSION = 'cccccccc-1111-2222-3333-444444444444';
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const prompt = (text) => `${JSON.stringify({ type: 'user', timestamp: '2026-11-14T10:00:00.000Z', message: { content: text } })}\n`;

async function harness(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, '');
  const emitted = [];
  const records = [];
  const clock = { now: T0 };
  const watcher = createSessionWatcher({
    path, label: 'cccccccc', sessionId: SESSION, once: false, stallMs: 20 * MIN, sessionsDir: join(dir, 'sessions'),
    now: () => clock.now, emit: (text) => emitted.push(text), record: (label, text) => records.push(`${label} ${text}`), ...extra,
  });
  return { dir, path, emitted, records, clock, watcher };
}

test('stall fires once after the limit, then RESUMED when the transcript is written again', async (t) => {
  const { path, emitted, clock, watcher } = await harness(t);
  await utimes(path, T0 / 1000, T0 / 1000);
  await watcher.poll();
  clock.now = T0 + 19 * MIN;
  await watcher.poll();
  assert.deepEqual(emitted, []);
  clock.now = T0 + 21 * MIN;
  await watcher.poll();
  clock.now = T0 + 30 * MIN;
  await watcher.poll();
  assert.deepEqual(emitted, ['cccccccc: STALL no transcript or subagent writes for 21 min']);
  await appendFile(path, prompt('go on'));
  await utimes(path, (T0 + 31 * MIN) / 1000, (T0 + 31 * MIN) / 1000);
  clock.now = T0 + 31 * MIN;
  await watcher.poll();
  assert.deepEqual(emitted.slice(1), ['cccccccc: OWNER go on', 'cccccccc: RESUMED writing again']);
});

test('a subagent transcript write keeps the session from stalling', async (t) => {
  const { dir, path, emitted, clock, watcher } = await harness(t);
  await utimes(path, T0 / 1000, T0 / 1000);
  const agentDir = join(dir, SESSION, 'subagents');
  await mkdir(agentDir, { recursive: true });
  await watcher.poll();
  await writeFile(join(agentDir, 'agent-a1.jsonl'), '');
  await utimes(join(agentDir, 'agent-a1.jsonl'), (T0 + 15 * MIN) / 1000, (T0 + 15 * MIN) / 1000);
  clock.now = T0 + 25 * MIN;
  await watcher.poll();
  assert.deepEqual(emitted, []);
  clock.now = T0 + 40 * MIN;
  await watcher.poll();
  assert.equal(emitted.length, 1);
  assert.match(emitted[0], /STALL/);
});

test('a partial last line is not lost: it prints once its newline arrives', async (t) => {
  const { path, emitted, watcher } = await harness(t);
  await watcher.poll();
  const line = prompt('half way');
  await appendFile(path, line.slice(0, 30));
  await watcher.poll();
  assert.deepEqual(emitted, []);
  await appendFile(path, line.slice(30));
  await watcher.poll();
  assert.deepEqual(emitted, ['cccccccc: OWNER half way']);
});

test('content already in the file when watching starts is not replayed in follow mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, prompt('old prompt'));
  const emitted = [];
  const watcher = createSessionWatcher({ path, label: 'cccccccc', sessionId: SESSION, once: false, stallMs: 20 * MIN, sessionsDir: dir, now: () => Date.now(), emit: (x) => emitted.push(x), record: () => {} });
  await watcher.poll();
  assert.deepEqual(emitted, []);
});

test('once mode reads existing content, flushes an unterminated last line and never reports a stall', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, prompt('first') + prompt('second').trimEnd());
  await utimes(path, 1, 1);
  const emitted = [];
  const watcher = createSessionWatcher({ path, label: 'cccccccc', sessionId: SESSION, once: true, stallMs: MIN, sessionsDir: dir, now: () => T0, emit: (x) => emitted.push(x), record: () => {} });
  await watcher.poll();
  watcher.finish();
  assert.deepEqual(emitted, ['cccccccc: OWNER first', 'cccccccc: OWNER second']);
});

async function addAgent(dir, name, meta, model) {
  const agentDir = join(dir, SESSION, 'subagents');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, `${name}.meta.json`), JSON.stringify(meta));
  await writeFile(join(agentDir, `${name}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { model } })}\n`);
}

test('subagent model mismatch: asked vs ran, and an unrequested Opus; a matching agent is only recorded', async (t) => {
  const { dir, emitted, records, watcher } = await harness(t);
  await watcher.poll();
  await addAgent(dir, 'agent-a1', { agentType: 'reviewer', model: 'sonnet' }, 'claude-haiku-5-5');
  await addAgent(dir, 'agent-a2', { agentType: 'general-purpose' }, 'claude-opus-5-5');
  await addAgent(dir, 'agent-a3', { agentType: 'scout', model: 'sonnet' }, 'claude-sonnet-5-5');
  await addAgent(dir, 'agent-a4', { agentType: 'runner' }, 'claude-sonnet-5-5');
  await watcher.poll();
  assert.deepEqual(emitted.sort(), [
    'cccccccc: MODEL MISMATCH type=general-purpose asked=none ran=claude-opus-5-5',
    'cccccccc: MODEL MISMATCH type=reviewer asked=sonnet ran=claude-haiku-5-5',
  ]);
  assert.equal(records.filter((line) => line.includes('AGENT_RAN')).length, 4);
  await watcher.poll();
  assert.equal(emitted.length, 2, 'each agent is judged once');
});

test('isModelMismatch', () => {
  assert.equal(isModelMismatch('opus', 'claude-opus-5-5'), false);
  assert.equal(isModelMismatch('opus', 'claude-sonnet-5-5'), true);
  assert.equal(isModelMismatch(undefined, 'claude-sonnet-5-5'), false);
  assert.equal(isModelMismatch(undefined, 'claude-fable-5-2'), true);
});

test('SESSION_END is reported once when the registered process is gone, and stops the stall check', async (t) => {
  const { dir, emitted, clock } = await harness(t);
  await mkdir(join(dir, 'sessions'));
  await writeFile(join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: SESSION }));
  let alive = true;
  const watcher = createSessionWatcher({ path: join(dir, `${SESSION}.jsonl`), label: 'cccccccc', sessionId: SESSION, once: false, stallMs: MIN, sessionsDir: join(dir, 'sessions'), now: () => clock.now, isAlive: () => alive, emit: (x) => emitted.push(x), record: () => {} });
  await watcher.poll();
  alive = false;
  clock.now = T0 + 99 * MIN;
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(emitted, ['cccccccc: SESSION_END pid=4242']);
});

test('guard follower: watched session only, secret-ask timeouts skipped, other timeouts printed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'guard.jsonl');
  await writeFile(log, '');
  const follower = createGuardFollower({ path: log, watched: new Map([[SESSION, 'cccccccc']]), fromStart: false });
  await follower.poll();
  const line = (over) => `${JSON.stringify({ hook: 'pre-bash-guard', outcome: 'timeout', reason: 'DESTRUCTIVE: x', command: 'rm x', session: SESSION, ...over })}\n`;
  await appendFile(log, line({}) + line({ session: 'dddddddd-0000' }) + line({ reason: 'the command contains a literal password/token (k)' }) + line({ outcome: 'allow' }));
  assert.deepEqual(await follower.poll(), ['cccccccc: GUARD timeout pre-bash-guard: DESTRUCTIVE: x | rm x']);
});
