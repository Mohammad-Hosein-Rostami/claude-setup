// Tests for IDLE: a session that finished its turn and waits for its owner is not a STALL. Session watcher with real temp files, a
// fake clock that moves in poll steps and an injected liveness check; then the real CLI for the wake rules. Synthetic transcripts only
// (made-up text; no prompt or command text of a real session).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { DEFAULT_EXIT_CLASSES, DELAYED_CLASSES, EVENT_CLASS, EXIT_CLASS_NAMES, internalClasses } from '../home/tools/watch/lib/events.mjs';
import { parseArgs } from '../home/tools/watch/lib/args.mjs';
import { createWakeGate } from '../home/tools/watch/lib/wake.mjs';
import { createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { CLI, SESSION, entry, startWatcher } from './watch-follow-helpers.mjs';

const SECOND = 1000;
const MIN = 60 * SECOND;
const POLL_MS = 1500;
const STALL_MS = 5 * MIN;
const RUN_MS = STALL_MS + 4 * POLL_MS; // long enough for the first verdict
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const registered = JSON.stringify({ pid: 4242, sessionId: SESSION });

const line = (at, value) => `${JSON.stringify({ timestamp: new Date(at).toISOString(), ...value })}\n`;
const turnDuration = (at) => line(at, { type: 'system', subtype: 'turn_duration' });
const systemNote = (at, subtype) => line(at, { type: 'system', subtype });
const attachment = (at) => line(at, { type: 'attachment', attachment: { type: 'note' } });
const reply = (at, stopReason, extra = {}) => line(at, { type: 'assistant', message: { content: [{ type: 'text', text: 'made-up answer' }], stop_reason: stopReason }, ...extra });
const toolCall = (at, extra = {}) => line(at, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' }, ...extra });
const toolResult = (at, extra = {}) => line(at, { type: 'user', message: { content: [{ type: 'tool_result', content: 'made-up output' }] }, ...extra });
const prompt = (at, text = 'made-up question', extra = {}) => line(at, { type: 'user', message: { content: text }, ...extra });
const finished = (at = T0) => reply(at - SECOND, 'end_turn') + turnDuration(at);

async function setup(t, { transcript, mtimeMs = T0, clockStart = T0, registry, isAlive, label = 'cccccccc' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-idle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, transcript);
  await utimes(path, mtimeMs / SECOND, mtimeMs / SECOND);
  const sessionsDir = join(dir, 'sessions');
  await mkdir(sessionsDir);
  if (registry !== undefined) await writeFile(join(sessionsDir, '4242.json'), registry);
  const clock = { now: clockStart };
  const emitted = [];
  const watcher = createSessionWatcher({
    path, label, sessionId: SESSION, once: false, exitMode: true, stallMs: STALL_MS, sessionsDir, now: () => clock.now, isAlive,
    emit: (text, cls) => emitted.push({ text, cls }), record: () => {},
  });
  return { dir, path, clock, emitted, watcher };
}

// Polls on the fake clock for `ms`, then returns the classes that were emitted.
async function run({ watcher, clock, emitted }, ms = RUN_MS) {
  const end = clock.now + ms;
  while (clock.now <= end) { await watcher.poll(); clock.now += POLL_MS; }
  return emitted.map((item) => item.cls);
}

async function verdictFor(t, transcript, options) {
  return run(await setup(t, { transcript, ...options }));
}

test('turn finished (turn_duration) and silence past the limit: IDLE, not STALL', async (t) => {
  const ctx = await setup(t, { transcript: finished() });
  assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE]);
  assert.match(ctx.emitted[0].text, /^cccccccc: IDLE turn ended 5 min ago, waiting for the owner$/);
});

test('older transcript shape (assistant end_turn or stop_sequence, no turn_duration): IDLE', async (t) => {
  assert.deepEqual(await verdictFor(t, reply(T0, 'end_turn')), [EVENT_CLASS.IDLE]);
  assert.deepEqual(await verdictFor(t, reply(T0, 'stop_sequence')), [EVENT_CLASS.IDLE]);
});

test('a finished turn that started the watch long ago: the first verdict is IDLE and it comes at the first poll', async (t) => {
  const longAgo = T0 - 3 * 60 * MIN;
  const ctx = await setup(t, { transcript: finished(longAgo), mtimeMs: longAgo });
  await ctx.watcher.poll();
  assert.deepEqual(ctx.emitted.map((item) => item.cls), [EVENT_CLASS.IDLE]);
  assert.match(ctx.emitted[0].text, /IDLE turn ended 180 min ago/);
});

test('a finished turn at the end of a transcript bigger than a megabyte is found', async (t) => {
  const filler = Array.from({ length: 4000 }, (_, index) => toolResult(T0 - 10 * SECOND + index, { note: 'x'.repeat(400) })).join('');
  assert.deepEqual(await verdictFor(t, filler + finished()), [EVENT_CLASS.IDLE]);
});

test('work in flight when the silence began stays a STALL', async (t) => {
  const cases = {
    'assistant tool_use': toolCall(T0),
    'tool result': toolCall(T0 - SECOND) + toolResult(T0),
    'owner prompt': finished(T0 - MIN) + prompt(T0),
    'stop_reason tool_use': reply(T0, 'tool_use'),
    'stop_reason max_tokens': reply(T0, 'max_tokens'),
    'stop_reason pause_turn': reply(T0, 'pause_turn'),
    'stop_reason refusal': reply(T0, 'refusal'),
    'unknown stop_reason': reply(T0, 'something_new'),
    'no stop_reason yet (streaming)': reply(T0, null),
    'API error entry (synthetic stop_sequence)': reply(T0, 'stop_sequence', { isApiErrorMessage: true, error: 'server_error' }),
    'empty transcript': '',
    'finished turn without a timestamp': JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n',
  };
  for (const [name, transcript] of Object.entries(cases)) assert.deepEqual(await verdictFor(t, transcript), [EVENT_CLASS.STALL], name);
});

test('later main-chain user or assistant entry after the turn end: the turn is running again (STALL)', async (t) => {
  const taskNotice = prompt(T0 + 2 * SECOND, '<task-notification>made-up</task-notification>');
  assert.deepEqual(await verdictFor(t, finished() + taskNotice), [EVENT_CLASS.STALL], 'task notification');
  assert.deepEqual(await verdictFor(t, finished() + toolCall(T0 + 2 * SECOND)), [EVENT_CLASS.STALL], 'assistant tool_use');
  assert.deepEqual(await verdictFor(t, finished() + reply(T0 + 2 * SECOND, null)), [EVENT_CLASS.STALL], 'streaming reply');
});

test('entries that count neither way after the turn end leave it IDLE', async (t) => {
  const noise = {
    attachment: attachment(T0 + 2 * SECOND),
    'other system subtype': systemNote(T0 + 2 * SECOND, 'stop_hook_summary'),
    'sidechain tool call': toolCall(T0 + 2 * SECOND, { isSidechain: true }),
    'sidechain tool result': toolResult(T0 + 2 * SECOND, { isSidechain: true }),
    'sidechain prompt': prompt(T0 + 2 * SECOND, 'made-up', { isSidechain: true }),
    'meta user entry': prompt(T0 + 2 * SECOND, 'made-up', { isMeta: true }),
    'compaction summary': prompt(T0 + 2 * SECOND, 'made-up summary', { isCompactSummary: true }),
    'partial last line': '{"type":"user","message":{"content":"made-up',
  };
  for (const [name, extra] of Object.entries(noise)) assert.deepEqual(await verdictFor(t, finished() + extra), [EVENT_CLASS.IDLE], name);
});

test('IDLE is reported once per idle period, then RESUMED when an owner prompt arrives, then STALL if the silence follows a prompt', async (t) => {
  const ctx = await setup(t, { transcript: finished() });
  assert.deepEqual(await run(ctx, 3 * STALL_MS), [EVENT_CLASS.IDLE]);
  await writeFile(ctx.path, finished() + prompt(ctx.clock.now));
  await utimes(ctx.path, ctx.clock.now / SECOND, ctx.clock.now / SECOND);
  assert.deepEqual(await run(ctx, 3 * STALL_MS), [EVENT_CLASS.IDLE, EVENT_CLASS.OWNER, EVENT_CLASS.RESUMED, EVENT_CLASS.STALL]);
  assert.match(ctx.emitted[2].text, /RESUMED writing again$/);
});

test('a subagent written after the turn end means work was in flight: STALL', async (t) => {
  const ctx = await setup(t, { transcript: finished() });
  await ctx.watcher.poll();
  const agentFile = join(dirname(ctx.path), SESSION, 'subagents', 'agent-a1.jsonl');
  await mkdir(dirname(agentFile), { recursive: true });
  await writeFile(agentFile, '{}\n');
  await utimes(agentFile, (T0 + 30 * SECOND) / SECOND, (T0 + 30 * SECOND) / SECOND);
  assert.deepEqual(await run(ctx, 30 * SECOND + RUN_MS), [EVENT_CLASS.STALL]);
});

test('a subagent written within 5 s of the turn end, or before it, does not stop the IDLE', async (t) => {
  for (const agentAt of [T0 + 4 * SECOND, T0 - MIN]) {
    const ctx = await setup(t, { transcript: finished() });
    const agentFile = join(dirname(ctx.path), SESSION, 'subagents', 'agent-a1.jsonl');
    await mkdir(dirname(agentFile), { recursive: true });
    await writeFile(agentFile, '{}\n');
    await utimes(agentFile, agentAt / SECOND, agentAt / SECOND);
    assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE], `agent write at ${agentAt - T0} ms`);
  }
});

test('after SESSION_END a silent session is STALL, never IDLE (the exit-mode guarantee)', async (t) => {
  const ctx = await setup(t, { transcript: finished(), registry: registered, isAlive: () => false });
  const classes = await run(ctx);
  assert.deepEqual(classes, [EVENT_CLASS.SESSION_END, EVENT_CLASS.STALL]);
  assert.ok(!internalClasses(['stall']).has(EVENT_CLASS.IDLE));
});

test('an IDLE already reported becomes a STALL when the session process then ends', async (t) => {
  let alive = true;
  const ctx = await setup(t, { transcript: finished(), registry: registered, isAlive: () => alive });
  assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE]);
  alive = false;
  assert.deepEqual(await run(ctx, 4 * POLL_MS), [EVENT_CLASS.IDLE, EVENT_CLASS.SESSION_END, EVENT_CLASS.STALL]);
});

test('a laptop-sleep jump while idle restarts the timer; the IDLE comes a full limit later', async (t) => {
  const ctx = await setup(t, { transcript: finished() });
  await ctx.watcher.poll();
  ctx.clock.now += 5 * 60 * MIN;
  await ctx.watcher.poll();
  assert.deepEqual(ctx.emitted, [], 'no verdict at the jump');
  ctx.clock.now += POLL_MS;
  assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE]);
});

test('transcript replaced by a new file whose turn is running: STALL, not the old IDLE', async (t) => {
  const ctx = await setup(t, { transcript: finished() });
  await ctx.watcher.poll();
  await unlink(ctx.path);
  await writeFile(ctx.path, toolCall(T0 + MIN));
  await utimes(ctx.path, T0 / SECOND, T0 / SECOND);
  assert.deepEqual(await run(ctx), [EVENT_CLASS.STALL]);
});

test('two sessions: the idle one reports IDLE, the one with a call in flight reports STALL', async (t) => {
  const idle = await setup(t, { transcript: finished(), label: 'aaaaaaaa' });
  const stalled = await setup(t, { transcript: toolCall(T0), label: 'bbbbbbbb' });
  await run(idle);
  await run(stalled);
  assert.deepEqual([idle.emitted[0].cls, stalled.emitted[0].cls], [EVENT_CLASS.IDLE, EVENT_CLASS.STALL]);
  const wanted = internalClasses(DEFAULT_EXIT_CLASSES);
  assert.deepEqual([...idle.emitted, ...stalled.emitted].filter((item) => wanted.has(item.cls)).map((item) => item.text.slice(0, 8)), ['bbbbbbbb']);
});

test('the classifier names the turn end only for a finished turn, from the timestamp of the entry', () => {
  const classifier = createClassifier();
  assert.equal(classifier.turnEndedAt, undefined);
  classifier.feed(reply(T0, 'end_turn'));
  assert.equal(classifier.turnEndedAt, T0);
  classifier.feed(turnDuration(T0 + SECOND));
  assert.equal(classifier.turnEndedAt, T0 + SECOND);
  classifier.feed(prompt(T0 + 2 * SECOND));
  assert.equal(classifier.turnEndedAt, undefined);
});

test('the class table has idle as an opt-in class that wakes on IDLE and is not delayed', () => {
  assert.ok(EXIT_CLASS_NAMES.includes('idle'));
  assert.ok(!DEFAULT_EXIT_CLASSES.includes('idle'));
  assert.deepEqual([...internalClasses(['idle'])], [EVENT_CLASS.IDLE]);
  assert.ok(!DELAYED_CLASSES.has(EVENT_CLASS.IDLE));
  assert.deepEqual(parseArgs(['abcdef', '--exit-on-event', 'idle,owner']).exitOnEvent, ['idle', 'owner']);
});

test('with a delay set, IDLE wakes at once and does not use up the stall retry window', () => {
  const woke = [];
  let now = 0;
  const gate = createWakeGate({ wanted: internalClasses(['idle', 'stall']), skip: 0, delayMs: 60 * SECOND, replies: () => 0, now: () => now, wake: (text, cls) => woke.push(cls) });
  gate('x: IDLE turn ended 5 min ago, waiting for the owner', EVENT_CLASS.IDLE);
  assert.deepEqual(woke, [EVENT_CLASS.IDLE]);
});

const WAKE_WAIT_MS = 20_000;
const QUIET_MS = 5_000;
const FAST_STALL = ['--stall-min', '0.03'];
const idleTranscript = entry({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } }) + entry({ type: 'system', subtype: 'turn_duration' });

test('CLI: --exit-on-event idle exits 0 with the IDLE line', async (t) => {
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: ['--exit-on-event', 'idle', ...FAST_STALL] });
  assert.equal(await watcher.waitForExit(WAKE_WAIT_MS), 0);
  assert.match(watcher.output(), /^eeeeeeee: IDLE turn ended \d+ min ago, waiting for the owner\n$/);
});

test('CLI: default --exit-on-event stays running while idle and exits with OWNER when a prompt arrives', async (t) => {
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: ['--exit-on-event', ...FAST_STALL] });
  assert.equal(await watcher.waitForExit(QUIET_MS), undefined, 'idle does not wake the default class list');
  assert.equal(watcher.output(), '');
  assert.equal(await watcher.appendUntilExit(entry({ type: 'user', message: { content: 'made-up question' } }), WAKE_WAIT_MS), 0);
  assert.match(watcher.output(), /^eeeeeeee: OWNER made-up question\n$/);
});

test('CLI: default --exit-on-event exits with STALL when a tool call was the last entry', async (t) => {
  const call = entry({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' } });
  const watcher = await startWatcher(t, { transcript: call, args: ['--exit-on-event', ...FAST_STALL] });
  assert.equal(await watcher.waitForExit(WAKE_WAIT_MS), 0);
  assert.match(watcher.output(), /^eeeeeeee: STALL no transcript or subagent writes for \d+ min\n$/);
});

test('CLI: follow mode without --exit-on-event prints the IDLE line', async (t) => {
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: FAST_STALL });
  const deadline = Date.now() + WAKE_WAIT_MS;
  while (!watcher.output().includes('IDLE') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(watcher.output(), /^eeeeeeee: IDLE turn ended \d+ min ago, waiting for the owner\n$/);
});

test('CLI: --help names the idle class and what it means', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /classes: .*\bidle\b/);
  assert.match(help.stdout, /idle \(opt-in\) = the session finished its turn and waits for its owner/);
});

test('docs name the idle class: README, daily use and the events header', async () => {
  const root = join(dirname(CLI), '..', '..', '..');
  for (const file of ['home/tools/watch/README.md', 'docs/daily-use.md', 'home/tools/watch/lib/events.mjs']) {
    assert.match(await readFile(join(root, file), 'utf8'), /\bidle\b/, file);
  }
});
