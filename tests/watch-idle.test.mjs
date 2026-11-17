// Tests for IDLE: a session that finished its turn and waits for its owner is not a STALL. Session watcher with real temp files, a
// fake clock that moves in poll steps and an injected liveness check (the CLI side is in watch-idle-cli.test.mjs). Synthetic transcripts only
// (made-up text; no prompt or command text of a real session).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { DEFAULT_EXIT_CLASSES, DELAYED_CLASSES, EVENT_CLASS, EXIT_CLASS_NAMES, internalClasses } from '../home/tools/watch/lib/events.mjs';
import { parseArgs } from '../home/tools/watch/lib/args.mjs';
import { createWakeGate } from '../home/tools/watch/lib/wake.mjs';
import { createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { SESSION } from './watch-follow-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

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
// A slash command that Claude Code handled itself: caveat (meta), command name, then its output (made-up text only).
const caveat = (at) => prompt(at, '<local-command-caveat>made-up caveat</local-command-caveat>', { isMeta: true });
const commandName = (at) => prompt(at, '<command-name>/made-up</command-name>');
const commandOutput = (at, tag = 'stdout') => prompt(at, `<local-command-${tag}>made-up output</local-command-${tag}>`);
const localCommand = (at, tag) => caveat(at) + commandName(at + 1) + commandOutput(at + 2, tag);
const finished = (at = T0) => reply(at - SECOND, 'end_turn') + turnDuration(at);

async function setup(t, { transcript, mtimeMs = T0, clockStart = T0, registry = registered, isAlive = () => true, label = 'cccccccc' } = {}) {
  const dir = makeTempDir('watch-idle-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, transcript);
  await utimes(path, mtimeMs / SECOND, mtimeMs / SECOND);
  const sessionsDir = join(dir, 'sessions');
  await mkdir(sessionsDir);
  if (registry !== null) await writeFile(join(sessionsDir, '4242.json'), registry);
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

// A subagent transcript with the given content, last written at `at`.
async function writeAgent(ctx, name, content, at) {
  const file = join(dirname(ctx.path), SESSION, 'subagents', `agent-${name}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, at / SECOND, at / SECOND);
}
const agentDone = (at) => reply(at, 'end_turn', { isSidechain: true });
const agentBusy = (at) => toolCall(at, { isSidechain: true });

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

test('a meta user entry with an origin kind (peer, auto-continuation, unknown) after the turn end means it runs again: STALL', async (t) => {
  for (const kind of ['peer', 'auto-continuation', 'some-new-kind']) {
    const meta = prompt(T0 + 2 * SECOND, 'made-up', { isMeta: true, origin: { kind } });
    assert.deepEqual(await verdictFor(t, finished() + meta), [EVENT_CLASS.STALL], kind);
  }
});

test('a meta user entry with no origin stays ignored: IDLE', async (t) => {
  assert.deepEqual(await verdictFor(t, finished() + prompt(T0 + 2 * SECOND, 'made-up', { isMeta: true })), [EVENT_CLASS.IDLE]);
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
  await writeAgent(ctx, 'a1', agentDone(T0 + 30 * SECOND), T0 + 30 * SECOND);
  assert.deepEqual(await run(ctx, 30 * SECOND + RUN_MS), [EVENT_CLASS.STALL]);
});

test('a subagent written within 5 s of the turn end, or before it, does not stop the IDLE', async (t) => {
  for (const agentAt of [T0 + 4 * SECOND, T0 - MIN]) {
    const ctx = await setup(t, { transcript: finished() });
    await writeAgent(ctx, 'a1', agentDone(agentAt), agentAt);
    assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE], `agent write at ${agentAt - T0} ms`);
  }
});

test('a subagent that did not finish before the turn end (within one stall limit) means STALL; a finished one, or an old unfinished one, does not', async (t) => {
  const cases = [
    ['unfinished 2 min before the turn end', agentBusy, 2 * MIN, EVENT_CLASS.STALL],
    ['finished 2 min before the turn end', agentDone, 2 * MIN, EVENT_CLASS.IDLE],
    ['unfinished, older than the stall limit before the turn end', agentBusy, STALL_MS + MIN, EVENT_CLASS.IDLE],
    ['last line cut in the middle', () => '{"type":"assistant","isSidechain":tru', 2 * MIN, EVENT_CLASS.STALL],
  ];
  for (const [name, content, before, expected] of cases) {
    const ctx = await setup(t, { transcript: finished() });
    await writeAgent(ctx, 'a1', content(T0 - before), T0 - before);
    assert.deepEqual(await run(ctx), [expected], name);
  }
});

test('a session with no known live process is never IDLE: no registry entry, or a process check that fails', async (t) => {
  assert.deepEqual(await verdictFor(t, finished(), { registry: null }), [EVENT_CLASS.STALL], 'no registry entry (watched by path)');
  const failing = () => { throw new Error('probe failed'); };
  const classes = await verdictFor(t, finished(), { isAlive: failing });
  assert.ok(!classes.includes(EVENT_CLASS.IDLE), 'a failing liveness check');
  assert.ok(classes.includes(EVENT_CLASS.STALL));
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

test('a transcript truncated to nothing, or replaced by one with only an attachment: STALL, not the old IDLE', async (t) => {
  const replacements = { 'truncated to empty': { content: '', replace: false }, 'replaced, attachment only': { content: attachment(T0 + SECOND), replace: true } };
  for (const [name, { content, replace }] of Object.entries(replacements)) {
    const ctx = await setup(t, { transcript: finished() });
    await ctx.watcher.poll();
    if (replace) await unlink(ctx.path);
    await writeFile(ctx.path, content);
    await utimes(ctx.path, (T0 + SECOND) / SECOND, (T0 + SECOND) / SECOND);
    assert.deepEqual(await run(ctx), [EVENT_CLASS.STALL], name);
  }
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

test('a local slash command after the turn end (caveat, command name, output) leaves it IDLE, counted from the original turn end', async (t) => {
  const ctx = await setup(t, { transcript: finished(T0 - 2 * MIN) + localCommand(T0 - SECOND) });
  assert.deepEqual(await run(ctx), [EVENT_CLASS.IDLE]);
  assert.match(ctx.emitted[0].text, /IDLE turn ended 7 min ago/);
});

test('local command output on stderr, or without the caveat, or as one text block: IDLE', async (t) => {
  const blockOutput = line(T0 + 3, { type: 'user', message: { content: [{ type: 'text', text: '<local-command-stdout>made-up</local-command-stdout>' }] } });
  const cases = {
    stderr: finished() + localCommand(T0 + SECOND, 'stderr'),
    'no caveat': finished() + commandName(T0 + SECOND) + commandOutput(T0 + 2 * SECOND),
    'one text block': finished() + caveat(T0 + SECOND) + commandName(T0 + 2 * SECOND) + blockOutput,
    'output only, no command name': finished() + commandOutput(T0 + SECOND),
    'a sidechain entry in between': finished() + caveat(T0 + SECOND) + commandName(T0 + 2 * SECOND) + toolCall(T0 + 3 * SECOND, { isSidechain: true }) + commandOutput(T0 + 4 * SECOND),
    'two local commands': finished() + localCommand(T0 + SECOND) + localCommand(T0 + 2 * SECOND),
  };
  for (const [name, transcript] of Object.entries(cases)) assert.deepEqual(await verdictFor(t, transcript), [EVENT_CLASS.IDLE], name);
});

test('a command name with no local output after it, or with the model working after it, stays a STALL', async (t) => {
  const cases = {
    'command name, then nothing': finished() + caveat(T0 + SECOND) + commandName(T0 + 2 * SECOND),
    'command name, then an assistant tool call': finished() + commandName(T0 + SECOND) + toolCall(T0 + 2 * SECOND),
    'command name, a tool call, then local output': finished() + commandName(T0 + SECOND) + toolCall(T0 + 2 * SECOND) + commandOutput(T0 + 3 * SECOND),
    'command name, a tool result, then local output': finished() + commandName(T0 + SECOND) + toolResult(T0 + 2 * SECOND) + commandOutput(T0 + 3 * SECOND),
    'command name, a meta entry with an origin, then local output': finished() + commandName(T0 + SECOND) + prompt(T0 + 2 * SECOND, 'made-up', { isMeta: true, origin: { kind: 'peer' } }) + commandOutput(T0 + 3 * SECOND),
    'output arrives before the command name': finished() + commandOutput(T0 + SECOND) + commandName(T0 + 2 * SECOND),
    'two command names, one output': finished() + commandName(T0 + SECOND) + commandName(T0 + 2 * SECOND) + commandOutput(T0 + 3 * SECOND),
  };
  for (const [name, transcript] of Object.entries(cases)) assert.deepEqual(await verdictFor(t, transcript), [EVENT_CLASS.STALL], name);
});

test('a real owner prompt after a local command is an OWNER line and the silence after it is a STALL', async (t) => {
  const ctx = await setup(t, { transcript: finished() + localCommand(T0 + SECOND) + prompt(T0 + 5 * SECOND) });
  assert.deepEqual(await run(ctx), [EVENT_CLASS.OWNER, EVENT_CLASS.STALL]);
});

test('a local command during a running turn does not make it idle: STALL', async (t) => {
  assert.deepEqual(await verdictFor(t, toolCall(T0 - SECOND) + localCommand(T0)), [EVENT_CLASS.STALL]);
});

test('a watch started on a transcript that already ends with a local command pair: the first verdict is IDLE', async (t) => {
  const longAgo = T0 - 3 * 60 * MIN;
  const ctx = await setup(t, { transcript: finished(longAgo) + localCommand(longAgo + 2 * SECOND), mtimeMs: longAgo });
  await ctx.watcher.poll();
  assert.deepEqual(ctx.emitted.map((item) => item.cls), [EVENT_CLASS.IDLE]);
  assert.match(ctx.emitted[0].text, /IDLE turn ended 180 min ago/);
});

test('the local command entries arriving in separate polls end IDLE; stopping after the command name is a STALL', async (t) => {
  for (const [name, entries, expected] of [
    ['all three', [caveat, commandName, commandOutput], EVENT_CLASS.IDLE],
    ['command name only', [caveat, commandName], EVENT_CLASS.STALL],
  ]) {
    const ctx = await setup(t, { transcript: finished() });
    await ctx.watcher.poll();
    for (const [index, entry] of entries.entries()) {
      await appendFile(ctx.path, entry(ctx.clock.now + index));
      await utimes(ctx.path, ctx.clock.now / SECOND, ctx.clock.now / SECOND);
      await ctx.watcher.poll();
      ctx.clock.now += POLL_MS;
    }
    assert.deepEqual(await run(ctx, RUN_MS + 3 * POLL_MS), [expected], name);
  }
});

test('the classifier restores the turn end only when local output follows the command name directly', () => {
  const classifier = createClassifier();
  classifier.feed(turnDuration(T0));
  classifier.feed(prompt(T0 + 1, ' \n<local-command-stdout>made-up</local-command-stdout>'));
  assert.equal(classifier.turnEndedAt, T0, 'output after blanks is still local output');
  classifier.feed(caveat(T0 + 1));
  classifier.feed(commandName(T0 + 2));
  assert.equal(classifier.turnEndedAt, undefined);
  classifier.feed(commandOutput(T0 + 3));
  assert.equal(classifier.turnEndedAt, T0);
  classifier.feed(commandName(T0 + 4));
  classifier.feed(systemNote(T0 + 5, 'stop_hook_summary'));
  classifier.feed(commandOutput(T0 + 6));
  assert.equal(classifier.turnEndedAt, T0, 'a system note that does not count leaves the pair intact');
  classifier.feed(commandName(T0 + 7));
  classifier.resetTurn();
  classifier.feed(commandOutput(T0 + 8));
  assert.equal(classifier.turnEndedAt, undefined, 'a reset forgets the turn end to restore');
});
