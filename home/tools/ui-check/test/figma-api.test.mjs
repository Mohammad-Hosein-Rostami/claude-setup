// Purpose: browser-free tests for lib/figma-api.mjs with a stubbed global fetch (real Response objects): no token is a UsageError
// before any call, the token goes only in the X-Figma-Token header and never into an error, an API error names the status and path,
// fetchNodes and fetchImages each make ONE API call and keep the asked order, ids and keys are URL-encoded. Exports: none.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { UsageError } from '../lib/errors.mjs';
import { fetchBaseline, fetchImages, fetchNode, fetchNodes } from '../lib/figma-api.mjs';
import { isolateEach } from './isolated-env.mjs';

isolateEach('figma-api');
const TOKEN = 'figd-test-token-not-real';
const FILE = 'FileKey1';
const API_HOST = 'api.figma.com';
const SIGNED = (id) => `https://figma-alpha-api.s3.example/${encodeURIComponent(id)}.png`;
const png = (id) => Buffer.from(`png bytes of ${id}`);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Replace fetch: `answer(url)` returns the Response; every call is recorded as {url, init}. */
function stubFetch(answer) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url));
  });
  return calls;
}

const nodesAnswer = (documents) => () => json({ nodes: Object.fromEntries(Object.entries(documents).map(([id, document]) => [id, { document }])) });
const apiCalls = (calls) => calls.filter((call) => new URL(call.url).host === API_HOST);

test('no FIGMA_TOKEN (unset or empty): a UsageError that names it, and no fetch call', async () => {
  const calls = stubFetch(() => json({}));
  for (const value of [undefined, '']) {
    if (value === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = value;
    await assert.rejects(fetchNodes(FILE, ['1:2']), (error) => error instanceof UsageError && /FIGMA_TOKEN is not set/.test(error.message));
    await assert.rejects(fetchImages(FILE, ['1:2'], 1), UsageError);
  }
  assert.equal(calls.length, 0);
});

test('the token is sent only as the X-Figma-Token header, never in the URL', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const calls = stubFetch(nodesAnswer({ '1:2': { id: '1:2' } }));
  await fetchNode(FILE, '1:2');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].init, { headers: { 'X-Figma-Token': TOKEN } });
  assert.ok(!calls[0].url.includes(TOKEN));
});

test('a non-ok API answer: the message has the status and the path only (no query, no token)', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  stubFetch(() => json({ err: `bad token ${TOKEN}` }, 403));
  await assert.rejects(fetchNodes(FILE, ['1:2', '3:4'], 2), (error) => {
    assert.equal(error.message, `Figma API 403 for /v1/files/${FILE}/nodes`);
    return !(error instanceof UsageError);
  });
  await assert.rejects(fetchImages(FILE, ['1:2'], 1), { message: `Figma API 403 for /v1/images/${FILE}` });
});

test('fetchNodes: ONE call for many ids, ids and the file key URL-encoded, the Map in the asked order', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const calls = stubFetch(nodesAnswer({ '5:6': { id: '5:6' }, '1:2': { id: '1:2' }, '3:4': { id: '3:4' } })); // answered out of order
  const documents = await fetchNodes('A B/C', ['3:4', '1:2', '5:6']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.figma.com/v1/files/A%20B%2FC/nodes?ids=3%3A4,1%3A2,5%3A6');
  assert.deepEqual([...documents.keys()], ['3:4', '1:2', '5:6']);
  assert.deepEqual(documents.get('1:2'), { id: '1:2' });
});

test('fetchNodes: depth is sent only when given', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const calls = stubFetch(nodesAnswer({ '1:2': { id: '1:2' } }));
  await fetchNodes(FILE, ['1:2'], 2);
  await fetchNodes(FILE, ['1:2'], 0);
  assert.match(calls[0].url, /\?ids=1%3A2&depth=2$/);
  assert.match(calls[1].url, /\?ids=1%3A2&depth=0$/);
});

test('fetchNodes: a node missing from the answer (absent, null document, no nodes at all) is "not found"', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const found = { '1:2': { document: { id: '1:2' } } };
  for (const nodes of [found, { ...found, '3:4': null }, { ...found, '3:4': { document: null } }]) {
    stubFetch(() => json({ nodes }));
    await assert.rejects(fetchNodes(FILE, ['1:2', '3:4']), { message: `node 3:4 not found in file ${FILE}` });
    mock.restoreAll();
  }
  stubFetch(() => json({}));
  await assert.rejects(fetchNodes(FILE, ['1:2']), { message: `node 1:2 not found in file ${FILE}` });
});

test('fetchImages: an empty list makes no call and needs no token', async () => {
  const calls = stubFetch(() => json({}));
  const images = await fetchImages(FILE, [], 2);
  assert.equal(images.size, 0);
  assert.equal(calls.length, 0);
});

test('fetchImages: ONE images call, then each signed URL is downloaded without the token, in the asked order', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const ids = ['7:8', '1:2'];
  const calls = stubFetch((url) => (new URL(url).host === API_HOST ? json({ images: Object.fromEntries(ids.map((id) => [id, SIGNED(id)])) }) : new Response(png(decodeURIComponent(url.split('/').at(-1).replace('.png', ''))))));
  const images = await fetchImages(FILE, ids, 2);
  assert.equal(apiCalls(calls).length, 1);
  assert.equal(calls[0].url, `https://api.figma.com/v1/images/${FILE}?ids=7%3A8,1%3A2&scale=2&format=png&use_absolute_bounds=true`);
  assert.deepEqual(calls.slice(1).map((call) => [call.url, call.init]), ids.map((id) => [SIGNED(id), undefined]));
  assert.deepEqual([...images.keys()], ids);
  assert.ok(images.get('1:2').equals(png('1:2')));
});

test('fetchImages: a null image url is an error naming the node, before any download', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  const calls = stubFetch(() => json({ images: { '1:2': null } }));
  await assert.rejects(fetchImages(FILE, ['1:2'], 1), { message: 'Figma returned no image for node 1:2' });
  assert.equal(calls.length, 1);
});

test('fetchBaseline: a failed download names its status only; the token appears in no error', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  stubFetch((url) => (new URL(url).host === API_HOST ? json({ images: { '1:2': SIGNED('1:2') } }) : new Response('denied', { status: 500 })));
  await assert.rejects(fetchBaseline(FILE, '1:2', 1), (error) => error.message === 'image download failed: 500' && !error.message.includes(TOKEN));
});

test('fetchBaseline: returns the PNG bytes of the one node', async () => {
  process.env.FIGMA_TOKEN = TOKEN;
  stubFetch((url) => (new URL(url).host === API_HOST ? json({ images: { '1:2': SIGNED('1:2') } }) : new Response(png('1:2'))));
  const bytes = await fetchBaseline(FILE, '1:2', 1);
  assert.ok(Buffer.isBuffer(bytes) && bytes.equals(png('1:2')));
});
