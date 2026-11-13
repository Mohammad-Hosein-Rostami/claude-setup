// Tests for recall's automatic semantic search: embed-on-index (resumable), auto merge in search, the reasons printed
// when Ollama is unusable, the loopback-only rule and re-redaction before embedding. Fake loopback Ollama; temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../home/tools/recall/lib/store.mjs';
import { cosineTop, embedQuery, embedTexts, ollamaBase } from '../home/tools/recall/lib/vectors.mjs';
import { appendFileSync } from 'node:fs';
import { insertedInputs, run, setup, user, withFake } from './recall-helpers.mjs';

// ---- A: semantic is automatic ----

test('index embeds the chunks without a vector and resumes: a second index only embeds the new chunk', async () => {
  const { env, file, db } = setup();
  await withFake({}, async (fake) => {
    const withUrl = { ...env, RECALL_OLLAMA_URL: fake.url };
    const first = await run(withUrl, 'index');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /embedded 2 chunks with fake/);
    assert.equal(insertedInputs(fake.calls).length, 2);
    assert.equal(fake.calls[0].keep_alive, '30m');
    appendFileSync(file, user('the dog barked'));
    const second = await run(withUrl, 'index');
    assert.match(second.stdout, /embedded 1 chunks with fake/);
    assert.equal(insertedInputs(fake.calls).length, 3, 'only the new chunk went to Ollama');
  });
  const store = openStore(db);
  assert.equal(store.vectorCount('fake'), 3);
  store.close();
});

test('search merges vectors automatically (finds a vector-only chunk) and --no-semantic stays lexical', async () => {
  const { env } = setup();
  await withFake({}, async (fake) => {
    const withUrl = { ...env, RECALL_OLLAMA_URL: fake.url };
    await run(withUrl, 'index');
    const auto = await run(withUrl, 'search', 'kitten');
    assert.match(auto.stdout, /feline friend/, 'the chunk with no query word comes from the vectors');
    assert.equal(auto.stderr, '');
    const callsBefore = fake.calls.length;
    const lexical = await run(withUrl, 'search', 'kitten', '--no-semantic');
    assert.ok(!/feline friend/.test(lexical.stdout));
    assert.equal(fake.calls.length, callsBefore, '--no-semantic never calls Ollama');
  });
});

test('the quick index before a search never embeds', async () => {
  const { env, db } = setup();
  await withFake({}, async (fake) => {
    const result = await run({ ...env, RECALL_OLLAMA_URL: fake.url }, 'search', 'kitten');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /recall: semantic off \(no fake vectors yet/);
    assert.equal(fake.calls.length, 0);
  });
  const store = openStore(db);
  assert.ok(store.stats().total > 0);
  assert.equal(store.vectorCount('fake'), 0);
  store.close();
});

test('Ollama unreachable: lexical answer plus exactly one stderr reason line', async () => {
  const { env } = setup();
  await withFake({}, async (fake) => run({ ...env, RECALL_OLLAMA_URL: fake.url }, 'index'));
  const result = await run(env, 'search', 'kitten');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /a kitten story/);
  const reasons = result.stderr.split('\n').filter((l) => l.startsWith('recall: semantic off'));
  assert.equal(reasons.length, 1, result.stderr);
  assert.match(reasons[0], /Ollama is not reachable/);
});

test('model missing (Ollama answers 404): lexical result and a stderr line naming the model', async () => {
  const { env, db } = setup();
  await run(env, 'index'); // dead Ollama: indexes lexically only
  const store = openStore(db);
  store.putVectors('fake', store.db.prepare('SELECT id FROM chunks').all().map((r) => ({ id: r.id, vec: Float32Array.from([1, 0, 0]) })));
  store.close();
  await withFake({ status: 404 }, async (fake) => {
    const result = await run({ ...env, RECALL_OLLAMA_URL: fake.url }, 'search', 'kitten');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /a kitten story/);
    assert.match(result.stderr, /recall: semantic off \(model fake is not pulled \(ollama pull fake\)\)/);
  });
});

test('cosineTop streams a generator and keeps only the k best (ties: lower id first)', () => {
  function* rows() {
    for (let id = 1; id <= 500; id += 1) yield { id, vec: Float32Array.from([id % 7 === 0 ? 1 : 0.1, id % 7 === 0 ? 0 : 0.99]) };
  }
  const top = cosineTop(rows(), Float32Array.from([1, 0]), 5);
  assert.deepEqual(top.map((t) => t.id), [7, 14, 21, 28, 35]);
});

// ---- C: loopback only, redacted before embedding ----

test('a non-loopback RECALL_OLLAMA_URL is refused by embed, index and search (exit 2)', async () => {
  const { env } = setup();
  const remote = { ...env, RECALL_OLLAMA_URL: 'http://example.com:11434' };
  for (const args of [['embed'], ['index'], ['search', 'kitten']]) {
    const result = await run(remote, ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /loopback/);
  }
});

test('ollamaBase accepts localhost, 127.0.0.1 and ::1 only', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(ollamaBase({ RECALL_OLLAMA_URL: `http://${host}:11434` }));
  for (const url of ['http://10.0.0.5:11434', 'http://localhost.evil.example', 'ftp://localhost', 'nonsense']) {
    assert.throws(() => ollamaBase({ RECALL_OLLAMA_URL: url }), url);
  }
});

test('texts and queries are redacted again before they are sent to Ollama', async () => {
  const secret = 'Zq8xTopSecretV4lue';
  await withFake({}, async (fake) => {
    const before = process.env.RECALL_OLLAMA_URL;
    process.env.RECALL_OLLAMA_URL = fake.url;
    try {
      await embedTexts('fake', [`connect with mysql -p${secret} now`]);
      await embedQuery('fake', `what is the password is ${secret}`);
    } finally {
      if (before === undefined) delete process.env.RECALL_OLLAMA_URL; else process.env.RECALL_OLLAMA_URL = before;
    }
    assert.equal(fake.calls.length, 2);
    for (const body of fake.calls) assert.ok(!JSON.stringify(body).includes(secret), JSON.stringify(body));
    assert.equal(fake.calls[0].keep_alive, '30m');
  });
});

