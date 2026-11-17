// Proof that `--exit-on-event` is never left waiting silently: for every way the watched transcript can stop growing, a session
// watcher in exit mode emits a wanted event within the stall time (plus a few polls). Real temp files, a fake clock that moves in
// poll steps, an injected liveness check. A case that needs a class list without session-end shows the stall check survives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_EXIT_CLASSES, internalClasses } from '../home/tools/watch/lib/events.mjs';
import { createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const MIN = 60_000;
const POLL_MS = 1500;
const STALL_MS = 5 * MIN;
const GRACE_MS = 3 * POLL_MS;
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const SESSION = 'cccccccc-1111-2222-3333-444444444444';
const reply = `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:00.000Z', message: { model: 'm', content: [] } })}\n`;
const STALL_ONLY = ['stall'];

// Runs the watcher on a fake clock until a line of a wanted class is emitted; returns how long that took (undefined: never).
async function timeToWake(watcher, clock, emitted, classNames, limitMs) {
  const wanted = internalClasses(classNames);
  const start = clock.now;
  while (clock.now - start <= limitMs) {
    await watcher.poll();
    if (emitted.some((item) => wanted.has(item.cls))) return clock.now - start;
    clock.now += POLL_MS;
  }
  return undefined;
}

async function setup(t, { transcript = reply, registry, isAlive, path: pathOverride } = {}) {
  const dir = makeTempDir('watch-silent-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = pathOverride?.(dir) ?? join(dir, `${SESSION}.jsonl`);
  if (transcript !== null) {
    await writeFile(path, transcript);
    await utimes(path, T0 / 1000, T0 / 1000);
  }
  const sessionsDir = join(dir, 'sessions');
  await mkdir(sessionsDir);
  if (registry !== undefined) await writeFile(join(sessionsDir, '4242.json'), registry);
  const clock = { now: T0 };
  const emitted = [];
  const watcher = createSessionWatcher({
    path, label: 'cccccccc', sessionId: SESSION, once: false, exitMode: true, stallMs: STALL_MS, sessionsDir, now: () => clock.now,
    isAlive, emit: (text, cls) => emitted.push({ text, cls }), record: () => {},
  });
  return { dir, path, clock, emitted, watcher };
}

const registered = JSON.stringify({ pid: 4242, sessionId: SESSION });
const classLists = { 'default classes': DEFAULT_EXIT_CLASSES, 'stall only': STALL_ONLY, 'api-error,stall,limit': ['api-error', 'stall', 'limit'] };

for (const [listName, classNames] of Object.entries(classLists)) {
  const wakes = async (t, options, limitMs = STALL_MS + GRACE_MS, between) => {
    const { clock, emitted, watcher, ...rest } = await setup(t, options);
    await watcher.poll();
    await between?.({ clock, emitted, watcher, ...rest });
    return timeToWake(watcher, clock, emitted, classNames, limitMs);
  };

  test(`never silent (${listName}): the registered process died`, async (t) => {
    assert.notEqual(await wakes(t, { registry: registered, isAlive: () => false }), undefined);
  });

  test(`never silent (${listName}): the process lives but nothing is written`, async (t) => {
    assert.notEqual(await wakes(t, { registry: registered, isAlive: () => true }), undefined);
  });

  test(`never silent (${listName}): the session is not in the registry at all`, async (t) => {
    assert.notEqual(await wakes(t, {}), undefined);
  });

  test(`never silent (${listName}): the registry file is garbage`, async (t) => {
    assert.notEqual(await wakes(t, { registry: '{not json' }), undefined);
  });

  test(`never silent (${listName}): the liveness check itself throws on every poll`, async (t) => {
    const throwing = () => { throw new Error('probe failed'); };
    assert.notEqual(await wakes(t, { registry: registered, isAlive: throwing }), undefined);
  });

  test(`never silent (${listName}): the transcript is deleted while watching`, async (t) => {
    assert.notEqual(await wakes(t, {}, STALL_MS + GRACE_MS, ({ path }) => unlink(path)), undefined);
  });

  test(`never silent (${listName}): the transcript never appears`, async (t) => {
    assert.notEqual(await wakes(t, { transcript: null }), undefined);
  });

  test(`never silent (${listName}): the transcript path cannot be read`, async (t) => {
    const options = { transcript: null, path: (dir) => join(dir, 'unreadable.jsonl') };
    assert.notEqual(await wakes(t, options, STALL_MS + GRACE_MS, ({ path }) => mkdir(path)), undefined);
  });

  test(`never silent (${listName}): the machine slept for hours, then the session stayed silent`, async (t) => {
    const asleep = ({ clock, watcher }) => { clock.now += 5 * 60 * MIN; return watcher.poll(); };
    assert.notEqual(await wakes(t, { registry: registered, isAlive: () => true }, STALL_MS + GRACE_MS, asleep), undefined);
  });
}

test('a dead process wakes within a few polls, long before the stall time', async (t) => {
  const { clock, emitted, watcher } = await setup(t, { registry: registered, isAlive: () => false });
  const took = await timeToWake(watcher, clock, emitted, DEFAULT_EXIT_CLASSES, STALL_MS);
  assert.ok(took <= GRACE_MS, `woke after ${took} ms`);
  assert.equal(emitted[0].cls, 'SESSION_END');
});

test('a session resumed in a new process is not ended: only when no registered process is alive', async (t) => {
  const { dir, clock, emitted, watcher } = await setup(t, { registry: registered, isAlive: (pid) => pid === 4343 });
  await writeFile(join(dir, 'sessions', '4343.json'), JSON.stringify({ pid: 4343, sessionId: SESSION }));
  const took = await timeToWake(watcher, clock, emitted, ['session-end'], 10 * POLL_MS);
  assert.equal(took, undefined, 'one live process among the registered ones means the session lives');
});

test('plain mode (not exit mode) keeps its old behaviour: no stall check after SESSION_END', async (t) => {
  const { dir, clock, emitted } = await setup(t, { registry: registered, isAlive: () => false });
  const plain = createSessionWatcher({
    path: join(dir, `${SESSION}.jsonl`), label: 'cccccccc', sessionId: SESSION, once: false, stallMs: STALL_MS, sessionsDir: join(dir, 'sessions'),
    now: () => clock.now, isAlive: () => false, emit: (text, cls) => emitted.push({ text, cls }), record: () => {},
  });
  await timeToWake(plain, clock, emitted, ['session-end'], POLL_MS * 3);
  clock.now += 2 * STALL_MS;
  await plain.poll();
  await plain.poll();
  assert.deepEqual(emitted.map((item) => item.cls), ['SESSION_END']);
});
