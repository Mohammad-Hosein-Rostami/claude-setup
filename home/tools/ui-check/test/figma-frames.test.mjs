// Purpose: browser-free tests for `figma-frames` (T9): framesOf on a stub node tree, and the command with a stubbed fetch
// (request URL with depth 2, output file, dedupe, no token printed, exit 2 without a token). Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { framesOf, run } from '../commands/figma-frames.mjs';
import { UsageError } from '../lib/errors.mjs';

const frame = (id, name, width, type = 'FRAME') => ({ id, name, type, absoluteBoundingBox: { x: 0, y: 0, width, height: 1024.2 } });
const PAGE = {
  id: '1:1', name: 'Hosted', type: 'CANVAS',
  children: [
    frame('8199:1', 'Org step 1', 1440),
    { id: '9:9', name: 'Emails', type: 'SECTION', children: [frame('9:10', 'Welcome email', 600.4), frame('9:11', 'Menu', 320, 'COMPONENT'), { id: '9:12', name: 'note', type: 'TEXT' }] },
    { id: '8:8', name: 'Loose text', type: 'TEXT' },
    { id: '8:9', name: 'Group', type: 'GROUP', children: [frame('8:10', 'Inside group', 100)] },
  ],
};

test('framesOf: FRAME and COMPONENT children of the node and of a SECTION under it; width is ceil; other types and deeper groups are not frames', () => {
  assert.deepEqual(framesOf(PAGE).map((f) => [f.node, f.name, f.page, f.width, f.height]), [
    ['8199:1', 'Org step 1', 'Hosted', 1440, 1025],
    ['9:10', 'Welcome email', 'Hosted', 601, 1025],
    ['9:11', 'Menu', 'Hosted', 320, 1025],
  ]);
});

test('framesOf: a node with no children or a frame without a bounding box gives no frames or a null width, never a crash', () => {
  assert.deepEqual(framesOf({ id: '1:2', name: 'Empty' }), []);
  assert.equal(framesOf({ name: 'P', children: [{ id: '2:1', name: 'F', type: 'FRAME' }] })[0].width, null);
});

// Replaces fetch for one test: answers each nodes request from `documents` and records the URLs asked.
function stubFetch(documents) {
  const urls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const id = new URL(url).searchParams.get('ids');
    return { ok: true, json: async () => ({ nodes: { [id]: { document: documents[id] } } }) };
  });
  return urls;
}

async function withToken(token, body) {
  const before = process.env.FIGMA_TOKEN;
  if (token === undefined) delete process.env.FIGMA_TOKEN; else process.env.FIGMA_TOKEN = token;
  try {
    return await body();
  } finally {
    mock.restoreAll();
    if (before === undefined) delete process.env.FIGMA_TOKEN; else process.env.FIGMA_TOKEN = before;
  }
}

test('run: writes the frames file for every --node (depth 2), lists a frame once, and never prints the token', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'figma-frames-')), 'frames.json');
  const logs = mock.method(console, 'log', () => {});
  await withToken('secret-token-value', async () => {
    const urls = stubFetch({ '1:1': PAGE, '1:2': { name: 'Second', children: [frame('8199:1', 'Org step 1', 1440), frame('5:5', 'Other', 800)] } });
    assert.equal(await run(['--file', 'KEY', '--node', '1:1', '--node', '1:2', '--out', out]), 0);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/v1\/files\/KEY\/nodes\?ids=1%3A1&depth=2$/);
  });
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.file, 'KEY');
  assert.match(written.source, /figma-frames --file KEY --node 1:1 --node 1:2/);
  assert.deepEqual(written.frames.map((f) => f.node), ['8199:1', '9:10', '9:11', '5:5']);
  assert.ok(!JSON.stringify([logs.mock.calls, written]).includes('secret-token-value'), 'the token is never printed or written');
  logs.mock.restore();
});

test('run: no token is a UsageError (exit 2) before any request; missing flags are a UsageError', async () => {
  await withToken(undefined, async () => {
    const urls = stubFetch({});
    await assert.rejects(() => run(['--file', 'K', '--node', '1:1', '--out', '/tmp/never.json']), (error) => error instanceof UsageError && /FIGMA_TOKEN/.test(error.message));
    assert.equal(urls.length, 0);
  });
  await assert.rejects(() => run(['--file', 'K']), UsageError);
});

test('run: a --node in the URL form (8199-243551) is asked for, and recorded, as 8199:243551', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'figma-frames-')), 'frames.json');
  const logs = mock.method(console, 'log', () => {});
  const urls = await withToken('t', async () => {
    const asked = stubFetch({ '8199:243551': PAGE });
    assert.equal(await run(['--file', 'KEY', '--node', '8199-243551', '--out', out]), 0);
    return asked;
  });
  logs.mock.restore();
  assert.match(urls[0], /ids=8199%3A243551&depth=2$/);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).source, /--node 8199:243551$/);
});
