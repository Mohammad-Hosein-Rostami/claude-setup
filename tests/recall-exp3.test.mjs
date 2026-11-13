// Tests for recall exp-3: model registry (qwen3 query prefix, Ollama name), rrf over several vector lists, --lists
// parsing, and the loopback reranker client (reorder, redaction, cap, loopback-only, soft failure). Fake loopback servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { embedQuery, embedTexts } from '../home/tools/recall/lib/vectors.mjs';
import { EMBED_MODELS, ollamaName, queryPrefix } from '../home/tools/recall/lib/models.mjs';
import { mergeSemantic } from '../home/tools/recall/lib/merge.mjs';
import { parseLists } from '../home/tools/recall/lib/pipeline.mjs';
import { MAX_DOC_CHARS, rerankBase, rerankHits } from '../home/tools/recall/lib/rerank.mjs';
import { withFake } from './recall-helpers.mjs';

const QWEN = 'qwen3-embedding-4b';

async function withEnv(name, value, fn) {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name]; else process.env[name] = before;
  }
}

/** Fake llama-server /v1/rerank: scores a document by `score(doc)`; records request bodies. */
async function fakeReranker({ score = (d) => (d.includes('needle') ? 0.9 : 0.1), status = 200, delayMs = 0 } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      calls.push({ path: req.url, ...parsed });
      setTimeout(() => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(status === 200 ? JSON.stringify({ results: parsed.documents.map((d, index) => ({ index, relevance_score: score(d) })) }) : '{"error":"boom"}');
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const hit = (id, text) => ({ id, text, score: 0 });

// ---- models ----

test('qwen3 queries get the instruction prefix, documents do not, and Ollama receives the full model name', async () => {
  assert.equal(ollamaName(QWEN), EMBED_MODELS[QWEN].ollama);
  assert.equal(ollamaName('fake'), 'fake', 'an unknown model is its own Ollama name');
  assert.equal(queryPrefix('bge-m3'), '');
  await withFake({}, async (fake) => {
    await withEnv('RECALL_OLLAMA_URL', fake.url, async () => {
      await embedTexts(QWEN, ['a document']);
      await embedQuery(QWEN, 'a question');
      await embedQuery('bge-m3', 'a question');
    });
    assert.equal(fake.calls[0].model, 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M');
    assert.deepEqual(fake.calls[0].input, ['a document']);
    assert.equal(fake.calls[1].input[0], 'Instruct: Given a search query, retrieve relevant passages from past developer chat sessions\nQuery: a question');
    assert.deepEqual(fake.calls[2].input, ['a question']);
  });
});

// ---- fusion ----

test('rrf fuses lexical with every vector list: a chunk ranked by two models beats one ranked by one', () => {
  const lexical = [{ id: 1 }, { id: 2 }];
  const extra = [{ id: 3 }, { id: 4 }];
  const bge = [{ id: 3, sim: 0.9 }, { id: 4, sim: 0.8 }];
  const qwen = [{ id: 4, sim: 0.9 }, { id: 3, sim: 0.5 }];
  const merged = mergeSemantic(lexical, extra, { lists: [bge, qwen], mode: 'rrf' });
  assert.deepEqual(merged.map((r) => r.id).slice(0, 2), [3, 4], 'both models agree on 3 and 4; lexical-only rows follow');
  const single = mergeSemantic(lexical, extra, { ranked: bge, mode: 'rrf' });
  assert.deepEqual(single.map((r) => r.id), mergeSemantic(lexical, extra, { lists: [bge], mode: 'rrf' }).map((r) => r.id));
});

test('parseLists needs lex and knows bge and qwen only', () => {
  assert.deepEqual(parseLists('lex'), []);
  assert.deepEqual(parseLists('lex,bge,qwen'), ['bge-m3', QWEN]);
  assert.deepEqual(parseLists('qwen, lex, qwen'), [QWEN]);
  assert.throws(() => parseLists('bge,qwen'), /must include lex/);
  assert.throws(() => parseLists('lex,gpt'), /unknown list gpt/);
});

// ---- reranker ----

test('rerankHits reorders by score, sends redacted capped text, and sets the score', async () => {
  const fake = await fakeReranker();
  try {
    const secret = 'Zq8xTopSecretV4lue';
    const hits = [hit(1, 'plain text'), hit(2, `needle ${'x'.repeat(MAX_DOC_CHARS * 2)}`), hit(3, 'other text')];
    const out = await rerankHits(`find the needle password is ${secret}`, hits, { env: { RECALL_RERANK_URL: fake.url } });
    assert.deepEqual(out.map((h) => h.id), [2, 1, 3], 'best first, ties keep the fused order');
    assert.equal(out[0].score, 0.9);
    assert.equal(fake.calls[0].path, '/v1/rerank');
    assert.ok(fake.calls[0].documents.every((d) => d.length <= MAX_DOC_CHARS));
    assert.ok(!fake.calls[0].query.includes(secret), 'the query is redacted');
  } finally {
    fake.close();
  }
});

test('rerankHits keeps the fused order and reports one reason when the server is down, slow, or answers an error', async () => {
  const hits = [hit(1, 'a'), hit(2, 'needle')];
  const reasons = [];
  const onOff = (r) => reasons.push(r);
  assert.deepEqual((await rerankHits('q', hits, { onOff, env: { RECALL_RERANK_URL: 'http://127.0.0.1:9' } })).map((h) => h.id), [1, 2]);
  const slow = await fakeReranker({ delayMs: 300 });
  const broken = await fakeReranker({ status: 500 });
  try {
    assert.deepEqual((await rerankHits('q', hits, { onOff, timeoutMs: 50, env: { RECALL_RERANK_URL: slow.url } })).map((h) => h.id), [1, 2]);
    assert.deepEqual((await rerankHits('q', hits, { onOff, env: { RECALL_RERANK_URL: broken.url } })).map((h) => h.id), [1, 2]);
  } finally {
    slow.close();
    broken.close();
  }
  assert.equal(reasons.length, 3, reasons.join(' | '));
  assert.match(reasons[0], /not reachable/);
  assert.match(reasons[1], /timed out/);
  assert.match(reasons[2], /reranker 500/);
});

test('the reranker URL must be loopback: refused before any request is made', async () => {
  for (const url of ['http://10.0.0.5:8012', 'http://localhost.evil.example', 'nonsense']) {
    assert.throws(() => rerankBase({ RECALL_RERANK_URL: url }), /RECALL_RERANK_URL/, url);
    await assert.rejects(rerankHits('q', [hit(1, 'a'), hit(2, 'b')], { env: { RECALL_RERANK_URL: url } }), /RECALL_RERANK_URL/);
  }
  assert.equal(rerankBase({}), 'http://127.0.0.1:8012');
});
