// Tests for the Stop-block counter (home/hooks/lib/stop-block-count.mjs): a hook runs once per Stop event, so its second block of
// the chain is the next continuation even when the model's reply text is identical (the old rule merged them into one count and
// the cap warning came late); gates of one event still count once; two hooks that block at the same moment keep the count file whole.
// Each test has a private HOME; the counter reads and writes only under it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { countBlock, readRecords, recordsDir, STOP_BLOCK_CAP } from '../home/hooks/lib/stop-block-count.mjs';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const COUNTER = fileURLToPath(new URL('../home/hooks/lib/stop-block-count.mjs', import.meta.url));
const SAME_REPLY = 'Done. Everything is committed.';
const privateEnv = () => {
  const home = makeTempDir('stop-cap-home-');
  return { HOME: home, USERPROFILE: home };
};
const stopInput = (session, extra = {}) => ({ hook_event_name: 'Stop', session_id: session, stop_hook_active: true, last_assistant_message: SAME_REPLY, ...extra });

test('one hook blocking every continuation with the same reply counts each block, and the cap record appears once past the cap', () => {
  const env = privateEnv();
  const first = countBlock('commit-gate', stopInput('same-reply-1', { stop_hook_active: false }), env);
  assert.equal(first.count, 1);
  for (let expected = 2; expected <= STOP_BLOCK_CAP + 1; expected += 1) {
    const result = countBlock('commit-gate', stopInput('same-reply-1'), env);
    assert.equal(result.count, expected, `block ${expected} with the same reply text`);
    assert.equal(result.overridden, expected > STOP_BLOCK_CAP);
  }
  const records = readRecords(env);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, 'gate overridden: commit-gate');
  countBlock('commit-gate', stopInput('same-reply-1'), env);
  assert.equal(readRecords(env).length, 1, 'the override is recorded once per chain');
});

test('gates of one Stop event (different hooks, same reply) still count once; the next continuation of any of them counts again', () => {
  const env = privateEnv();
  const input = stopInput('same-event-1');
  assert.equal(countBlock('commit-gate', input, env).count, 1);
  assert.equal(countBlock('git-tidy-gate', input, env).count, 1);
  assert.equal(countBlock('ask-gate', input, env).count, 1);
  assert.equal(countBlock('git-tidy-gate', input, env).count, 2, 'the same hook again is a new event');
});

test('a counts file stored before eventHooks existed still reads: no crash, the chain goes on', () => {
  const env = privateEnv();
  const stored = { agents: { lead: { n: 3, at: Date.now(), key: 'old-key', hooks: ['commit-gate'], recorded: false } } };
  assert.equal(writeSessionFile(join(recordsDir(env), 'counts'), 'old-entry-1', JSON.stringify(stored)), true);
  assert.equal(countBlock('commit-gate', stopInput('old-entry-1'), env).count, 4);
});

test('two Stop hooks blocking at the same moment on one session lose no update (the count file lock holds)', async () => {
  const env = privateEnv();
  const hooks = ['commit-gate', 'git-tidy-gate', 'ask-gate', 'final-reply-cap', 'ui-proof-gate', 'done-check'];
  const script = `import(${JSON.stringify(COUNTER)}).then(({ countBlock }) => {
    const input = ${JSON.stringify(stopInput('parallel-1'))};
    countBlock(process.argv[1], input, process.env);
  });`;
  await Promise.all(hooks.map((hook) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, hook], { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${hook} exited ${code}`))));
  })));
  const stored = JSON.parse(readFileSync(join(recordsDir(env), 'counts', 'parallel-1.json'), 'utf8'));
  assert.equal(stored.agents.lead.n, 1, 'one event');
  assert.deepEqual([...stored.agents.lead.eventHooks].sort(), [...hooks].sort(), 'every hook that blocked is kept');
});
