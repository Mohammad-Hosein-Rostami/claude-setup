// Tests for IDLE on the real CLI: which flags wake on it, that the default class list does not, the help text and the docs.
// Synthetic transcripts only (made-up text).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLI, SESSION, entry, startWatcher } from './watch-follow-helpers.mjs';

const WAKE_WAIT_MS = 20_000;
const QUIET_MS = 5_000;
const FAST_STALL = ['--stall-min', '0.03'];
// The watcher knows a live process for the session: this test process itself.
const liveProcess = async ({ home }) => {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  await writeFile(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION }));
};
const idleTranscript = entry({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } }) + entry({ type: 'system', subtype: 'turn_duration' });

test('CLI: --exit-on-event idle exits 0 with the IDLE line', async (t) => {
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: ['--exit-on-event', 'idle', ...FAST_STALL], prepare: liveProcess });
  assert.equal(await watcher.waitForExit(WAKE_WAIT_MS), 0);
  assert.match(watcher.output(), /^eeeeeeee: IDLE turn ended \d+ min ago, waiting for the owner\n$/);
});

test('CLI: default --exit-on-event stays running while idle and exits with OWNER when a prompt arrives', async (t) => {
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: ['--exit-on-event', ...FAST_STALL], prepare: liveProcess });
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
  const watcher = await startWatcher(t, { transcript: idleTranscript, args: FAST_STALL, prepare: liveProcess });
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

test('docs name the idle class: README and the events header (daily use no longer covers watch)', async () => {
  const root = join(dirname(CLI), '..', '..', '..');
  for (const file of ['home/tools/watch/README.md', 'home/tools/watch/lib/events.mjs']) {
    assert.match(await readFile(join(root, file), 'utf8'), /\bidle\b/, file);
  }
});
