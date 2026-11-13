// Tests for the final search stack's reranker: the fallback chain (deep -> fast -> fused, one printed line per skipped
// stage), the on-demand llama-server (start, reuse, swap for --deep, idle stop, foreign-server guard) and the CLI flags.
// Uses a fake `llama-server` on PATH; never loads a real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rerankChain } from '../home/tools/recall/lib/pipeline.mjs';
import { RERANK_FILES, RERANK_STATE_FILE, ensureServer, readServer, stopServer } from '../home/tools/recall/lib/rerank-server.mjs';
import { ownsServer, watch } from '../home/tools/recall/lib/rerank-watch.mjs';
import { run, setup, withFake } from './recall-helpers.mjs';
import { fakeStack } from './recall-fakes.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hits = ['alpha beta unrelated', 'the reranker port is 8012', 'gamma only'].map((text, id) => ({ id, text, score: 1 }));
async function waitFor(check, ms = 10000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(40)) if (await check()) return true;
  return false;
}
const stopAfter = (env) => async () => { const state = readServer(env); if (state) await stopServer(state, env); };

test('the fast tier starts on demand, reranks, is reused while warm and stops on request', async (t) => {
  const { env, llamaStarts } = fakeStack();
  t.after(stopAfter(env));
  const skipped = [];
  const ordered = await rerankChain('reranker port', hits, { env, onSkip: (...args) => skipped.push(args) });
  assert.equal(ordered[0].id, 1, 'the document that matches the query comes first');
  assert.deepEqual(skipped, []);
  assert.equal(llamaStarts().length, 1);
  assert.match(llamaStarts()[0].model, /qwen3-reranker-0\.6b/);
  assert.equal(readServer(env).tier, 'fast');
  await rerankChain('reranker port', hits, { env });
  assert.equal(llamaStarts().length, 1, 'a warm server is reused');
});

test('--deep uses the 4B model and swaps the server: one server at a time, and back to 0.6B afterwards', async (t) => {
  const { env, llamaStarts } = fakeStack();
  t.after(stopAfter(env));
  await rerankChain('reranker port', hits, { env });
  const fastPid = readServer(env).pid;
  await rerankChain('reranker port', hits, { env, deep: true });
  assert.equal(readServer(env).tier, 'deep');
  assert.match(llamaStarts().at(-1).model, /qwen3-reranker-4b/);
  assert.equal(alive(fastPid), false, 'the 0.6B server was stopped before the 4B one started');
  await rerankChain('reranker port', hits, { env });
  assert.equal(readServer(env).tier, 'fast');
});

test('fallback chain: a missing 4B file falls back to 0.6B and says so; a missing 0.6B file keeps the fused order', async (t) => {
  const { env } = fakeStack();
  t.after(stopAfter(env));
  rmSync(join(env.RECALL_RERANK_MODEL_DIR, RERANK_FILES.deep));
  const skipped = [];
  const ordered = await rerankChain('reranker port', hits, { env, deep: true, onSkip: (...a) => skipped.push(a) });
  assert.equal(ordered[0].id, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0][1], /model file missing/);
  assert.match(skipped[0][0], /4B/i);
  assert.match(skipped[0][2], /0\.6B/i);
  rmSync(join(env.RECALL_RERANK_MODEL_DIR, RERANK_FILES.fast));
  const again = [];
  const fused = await rerankChain('reranker port', hits, { env: { ...env, RECALL_RERANK_PORT: String(Number(env.RECALL_RERANK_PORT) + 1) }, deep: true, onSkip: (...a) => again.push(a) });
  assert.deepEqual(fused.map((h) => h.id), [0, 1, 2], 'fused order is kept');
  assert.equal(again.length, 2, 'one line per skipped stage');
  assert.equal(again[1][2], null);
});

test('a missing llama-server binary is a skipped stage with the install hint, not a crash', async () => {
  const { env } = fakeStack();
  const skipped = [];
  const ordered = await rerankChain('reranker port', hits, { env: { ...env, PATH: '/nonexistent' }, onSkip: (...a) => skipped.push(a) });
  assert.deepEqual(ordered.map((h) => h.id), [0, 1, 2]);
  assert.match(skipped[0][1], /llama-server is not installed/);
});

test('a llama-server that recall did not start blocks the start (never two big models); Ollama runners do not count', async (t) => {
  const { env, bin, dir, llamaStarts } = fakeStack();
  const foreignDir = join(dir, 'foreign');
  const ollamaDir = join(dir, 'ollama', 'lib');
  for (const d of [foreignDir, ollamaDir]) { mkdirSync(d, { recursive: true }); copyFileSync(join(bin, 'llama-server'), join(d, 'llama-server')); chmodSync(join(d, 'llama-server'), 0o755); }
  const checked = { ...env, RECALL_RERANK_FOREIGN_CHECK: 'on', RECALL_RERANK_FOREIGN_MATCH: dir }; // only this test's processes count, never the owner's real servers
  const ollama = spawn(join(ollamaDir, 'llama-server'), ['-m', 'x', '--port', '18999'], { stdio: 'ignore', env });
  t.after(() => ollama.kill());
  assert.ok(await waitFor(() => llamaStarts().length >= 1), 'the Ollama stand-in is running');
  t.after(stopAfter(checked));
  const first = await ensureServer({ env: checked });
  assert.ok(first.base, 'an Ollama runner is not a foreign server');
  await stopAfter(checked)();
  const foreign = spawn(join(foreignDir, 'llama-server'), ['-m', 'x', '--port', '18998'], { stdio: 'ignore', env });
  t.after(() => foreign.kill());
  assert.ok(await waitFor(() => llamaStarts().length >= 3), 'the foreign server is running');
  await assert.rejects(ensureServer({ env: checked }), /another llama-server is running/);
});

test('the watchdog stops an idle server and removes its state', async () => {
  const { env } = fakeStack();
  const idleEnv = { ...env, RECALL_RERANK_IDLE_MS: '400' };
  await rerankChain('reranker port', hits, { env: idleEnv });
  const { pid } = readServer(idleEnv);
  assert.equal(alive(pid), true);
  assert.ok(await waitFor(() => !alive(pid), 8000), 'server was stopped after the idle limit');
  assert.equal(readServer(idleEnv), null);
});

test('a search keeps the server warm: the idle clock restarts on use', async (t) => {
  const { env } = fakeStack();
  const idleEnv = { ...env, RECALL_RERANK_IDLE_MS: '1500' };
  t.after(stopAfter(idleEnv));
  await rerankChain('reranker port', hits, { env: idleEnv });
  const { pid } = readServer(idleEnv);
  for (let i = 0; i < 4; i += 1) { await sleep(500); await rerankChain('reranker port', hits, { env: idleEnv }); }
  assert.equal(alive(pid), true, 'still alive after 2 s of use with a 1.5 s limit');
});

test('CLI: the default stack reranks; --deep with no 4B file prints one skipped-stage line and falls back to 0.6B', async (t) => {
  const stack = fakeStack();
  t.after(stopAfter(stack.env));
  const texts = ['the reranker idea only', 'the reranker port is 8012'];
  const { env: base } = setup(texts.map((text) => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`));
  await withFake({}, async (fake) => {
    const env = { ...stack.env, RECALL_DB: base.RECALL_DB, RECALL_ROOT: base.RECALL_ROOT, RECALL_OLLAMA_URL: fake.url };
    assert.equal((await run(env, 'index')).status, 0);
    const result = await run(env, 'reranker port');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /skipped/);
    assert.match(result.stdout.split('\n').find((l) => /reranker/.test(l)), /8012/, 'the reranker put the matching chunk first');
    assert.equal(stack.llamaStarts().length, 1, 'the default search used the on-demand server');
    rmSync(join(env.RECALL_RERANK_MODEL_DIR, RERANK_FILES.deep));
    const deep = await run(env, 'reranker port', '--deep');
    assert.equal(deep.status, 0, deep.stderr);
    assert.match(deep.stderr, /recall: skipped qwen3-reranker-4b \(model file missing.*\); using qwen3-reranker-0\.6b/);
    assert.equal(deep.stderr.match(/skipped/g).length, 1);
    assert.match(deep.stdout, /8012/);
  });
});

test('a state file whose pid was recycled by an unrelated process is dropped, never signalled', async (t) => {
  const { env } = fakeStack();
  const stranger = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => stranger.kill());
  const statePath = join(env.RECALL_STATE_DIR, RERANK_STATE_FILE);
  mkdirSync(env.RECALL_STATE_DIR, { recursive: true });
  const state = { pid: stranger.pid, port: Number(env.RECALL_RERANK_PORT), tier: 'fast', startedAt: Date.now() - 3600000, lastUsed: Date.now() - 3600000 };
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(ownsServer(state), false);
  assert.equal(readServer(env), null, 'the stale state is removed');
  assert.ok(!existsSync(statePath));
  writeFileSync(statePath, JSON.stringify(state));
  await stopServer(state, env);
  assert.equal(alive(stranger.pid), true, 'stopServer did not signal the stranger');
  writeFileSync(statePath, JSON.stringify(state));
  await watch(statePath, stranger.pid, { idleMs: 10 });
  assert.equal(alive(stranger.pid), true, 'the watchdog did not signal the stranger');
  assert.ok(!existsSync(statePath));
  for (const pid of [1, 0, -5, 1.5, '123', null]) assert.equal(ownsServer({ pid, port: 1, startedAt: 0 }), false, `pid ${pid}`);
});
