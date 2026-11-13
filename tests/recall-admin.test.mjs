// Tests for `recall status` and `recall backfill` (lib/cli-admin.mjs) with a fake `claude` on PATH and no Ollama.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './recall-helpers.mjs';
import { bigTranscript, fakeStack } from './recall-fakes.mjs';

const OLD_BIG = 'aaaaaaaa-1111-2222-3333-444444444444';
const OLD_SMALL = 'bbbbbbbb-1111-2222-3333-444444444444';

function twoSessions() {
  const stack = fakeStack();
  bigTranscript(stack.dir, { count: 15, size: 200, name: OLD_BIG });
  bigTranscript(stack.dir, { count: 3, size: 200, name: OLD_SMALL });
  return { ...stack, env: { ...stack.env, RECALL_RERANK: 'off' } };
}

test('backfill prints an estimate and runs nothing without --yes', async () => {
  const { env, claudeCalls } = twoSessions();
  const result = await run(env, 'backfill');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /backfill: 1 sessions with >= 20 messages and no notes; 1 Haiku calls, ~[\d.]+k input \+ ~[\d.]+k output tokens/);
  assert.match(result.stdout, /aaaaaaaa .*30 messages/);
  assert.doesNotMatch(result.stdout, /bbbbbbbb/);
  assert.match(result.stdout, /Nothing was run\. Add --yes/);
  assert.equal(claudeCalls().length, 0);
});

test('backfill --min-messages changes the filter; --yes summarises, and a second run finds nothing left', async () => {
  const { env, claudeCalls } = twoSessions();
  assert.match((await run(env, 'backfill', '--min-messages', '5')).stdout, /backfill: 2 sessions with >= 5 messages/);
  const done = await run(env, 'backfill', '--yes');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /aaaaaaaa: \d+ notes from 1 windows/);
  assert.equal(claudeCalls().length, 1);
  const again = await run(env, 'backfill', '--min-messages', '5', '--yes');
  assert.match(again.stdout, /backfill: 1 sessions/, 'the summarised session is skipped');
  assert.equal(claudeCalls().length, 2);
  const status = await run(env, 'status');
  assert.match(status.stdout, /index: \d+ chunks, \d+ sessions, \d+ notes/);
  assert.match(status.stdout, /checkpoint aaaaaaaa: .*notes, lines 1-30/);
  assert.match(status.stdout, /haiku tokens \(counted\): today 1\.\dk in 2 calls/);
});

test('backfill rejects a bad --min-messages with a usage error', async () => {
  const { env } = twoSessions();
  const result = await run(env, 'backfill', '--min-messages', 'many');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /min-messages/);
});

test('status lists the reranker files and an unreachable Ollama, and starts nothing', async () => {
  const { env, claudeCalls, llamaStarts } = twoSessions();
  const result = await run(env, 'status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reranker server: not running/);
  assert.match(result.stdout, /reranker files: qwen3-reranker-0\.6b-q8_0\.gguf ok, qwen3-reranker-4b-q8_0\.gguf ok/);
  assert.match(result.stdout, /ollama: not reachable/);
  assert.match(result.stdout, /checkpoints: none yet/);
  assert.equal(claudeCalls().length + llamaStarts().length, 0);
});
