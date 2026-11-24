// Purpose: browser-free tests for figma-refresh's compareEntry (new / unchanged / changed by spec and baseline bytes) and figma-pull's
// fetchTargets (one nodes call, one images call, hidden targets, skip, meta), with fetch stubbed and HOME pointed at a temp folder so
// lib/cache.mjs's default root (~/.cache/figma) is never the real one. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { cacheDir, writeCache } from '../lib/cache.mjs';
import { UsageError } from '../lib/errors.mjs';
import { compareEntry, run as refresh } from '../commands/figma-refresh.mjs';
import { fetchTargets } from '../commands/figma-pull.mjs';
import { isolateEach } from './isolated-env.mjs';

const root = isolateEach('figma-refresh');
const FILE = 'FileKey1';
const API_HOST = 'api.figma.com';
const SPEC = { root: { id: '12:40', name: 'Card', w: 10, h: 5, render: null }, nodes: [] };
const png = (id) => Buffer.from(`png of ${id}`);
const box = (width, height) => ({ x: 100, y: 100, width, height });

// A page with a visible frame, a hidden frame and a component set of two variants (the whole subtree, as one nodes call returns it).
const PAGE = {
  id: '1:1', name: 'Page', type: 'CANVAS',
  children: [
    { id: '2:1', name: 'Home', type: 'FRAME', absoluteBoundingBox: box(320, 640) },
    { id: '2:2', name: 'Draft', type: 'FRAME', visible: false, absoluteBoundingBox: box(320, 640) },
    { id: '3:1', name: 'Button', type: 'COMPONENT_SET', absoluteBoundingBox: box(200, 40), children: [
      { id: '3:2', name: 'State=Rest', type: 'COMPONENT', absoluteBoundingBox: box(90, 40) },
      { id: '3:3', name: 'State=Hover', type: 'COMPONENT', absoluteBoundingBox: box(90, 40) },
    ] },
  ],
};

/** Stub fetch: the nodes call answers `document`, the images call a signed URL per asked id, a download its PNG bytes. */
function stubFigma(document = PAGE) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.host !== API_HOST) return new Response(png(url.searchParams.get('id')));
    if (url.pathname.includes('/nodes')) return Response.json({ nodes: { [url.searchParams.get('ids')]: { document } } });
    const ids = url.searchParams.get('ids').split(',');
    return Response.json({ images: Object.fromEntries(ids.map((id) => [id, `https://signed.example/x.png?id=${id}`])) });
  });
  return { calls, api: () => calls.filter((url) => url.host === API_HOST) };
}

const entry = (spec = SPEC, bytes = png('12:40')) => ({ target: { node: '12:40', name: 'Card', kind: 'frame' }, png: bytes, spec });

test('the cache root follows the temp HOME, never the real home', () => {
  assert.equal(cacheDir(FILE, '12:40'), path.join(root(), 'home', '.cache', 'figma', FILE, '12-40'));
  assert.equal(os.tmpdir(), path.join(root(), 'tmp'));
});

test('compareEntry: no cache folder, or one missing a file, is "new"', () => {
  const expected = { node: '12:40', kind: 'frame', name: 'Card', status: 'new', differs: 'not in the cache' };
  assert.deepEqual(compareEntry(FILE, entry()), expected);
  const dir = writeCache(cacheDir(FILE, '12:40'), { png: png('12:40'), spec: SPEC, meta: {} });
  fs.rmSync(path.join(dir, 'meta.json'));
  assert.deepEqual(compareEntry(FILE, entry()), expected);
});

test('compareEntry: equal spec and bytes is "unchanged"; an undefined field (dropped by JSON) does not count as a change', () => {
  writeCache(cacheDir(FILE, '12:40'), { png: png('12:40'), spec: SPEC, meta: {} });
  const withUndefined = { ...SPEC, root: { ...SPEC.root, extra: undefined } };
  assert.deepEqual(compareEntry(FILE, entry(withUndefined)), { node: '12:40', kind: 'frame', name: 'Card', status: 'unchanged', differs: '' });
});

test('compareEntry: a changed spec, changed baseline bytes, or both are "changed" and named', () => {
  writeCache(cacheDir(FILE, '12:40'), { png: png('12:40'), spec: SPEC, meta: {} });
  const wider = { ...SPEC, root: { ...SPEC.root, w: 11 } };
  const status = (e) => [compareEntry(FILE, e).status, compareEntry(FILE, e).differs];
  assert.deepEqual(status(entry(wider)), ['changed', 'spec']);
  assert.deepEqual(status(entry(SPEC, png('other'))), ['changed', 'baseline bytes']);
  assert.deepEqual(status(entry(wider, png('other'))), ['changed', 'spec, baseline bytes']);
});

test('fetchTargets: ONE nodes call (whole subtree) and ONE images call for the visible targets; hidden ones are counted, not fetched', async () => {
  process.env.FIGMA_TOKEN = 'figd-test-token-not-real';
  const { calls, api } = stubFigma();
  const { targets, hidden, entries } = await fetchTargets(FILE, '1:1', 2);
  assert.equal(api().length, 2);
  assert.equal(api()[0].searchParams.get('depth'), null);
  assert.equal(api()[1].searchParams.get('ids'), '2:1,3:2,3:3');
  assert.equal(api()[1].searchParams.get('scale'), '2');
  assert.equal(calls.length, 2 + 3, 'one download per target');
  assert.deepEqual(targets.map((t) => [t.node, t.kind]), [['2:1', 'frame'], ['3:2', 'variant'], ['3:3', 'variant']]);
  assert.equal(hidden, 1);
  assert.deepEqual(entries.map((e) => [e.target.node, e.png.equals(png(e.target.node)), e.spec.root.w]), [['2:1', true, 320], ['3:2', true, 90], ['3:3', true, 90]]);
});

test('fetchTargets: meta says where each entry came from; variants carry their set', async () => {
  process.env.FIGMA_TOKEN = 'figd-test-token-not-real';
  stubFigma();
  const { entries } = await fetchTargets(FILE, '1:1', 2);
  const { fetchedAt, ...frameMeta } = entries[0].meta;
  assert.deepEqual(frameMeta, { fileKey: FILE, nodeId: '2:1', scale: 2, width: 320, height: 640, kind: 'frame', pulledFrom: '1:1', source: 'api' });
  assert.equal(new Date(fetchedAt).toISOString(), fetchedAt);
  assert.equal(entries[1].meta.set, 'Button');
  assert.equal('set' in entries[0].meta, false);
});

test('fetchTargets: skipped targets stay in targets but are not fetched; all skipped makes no images call', async () => {
  process.env.FIGMA_TOKEN = 'figd-test-token-not-real';
  const { api } = stubFigma();
  const some = await fetchTargets(FILE, '1:1', 1, (target) => target.node === '3:2');
  assert.deepEqual([some.targets.length, some.entries.map((e) => e.target.node)], [3, ['2:1', '3:3']]);
  assert.equal(api()[1].searchParams.get('ids'), '2:1,3:3');
  mock.restoreAll();
  const second = stubFigma();
  const none = await fetchTargets(FILE, '1:1', 1, () => true);
  assert.deepEqual([none.entries, second.api().length], [[], 1]);
});

test('fetchTargets: a node with no target is a UsageError; a target without a bounding box fails before any images call', async () => {
  process.env.FIGMA_TOKEN = 'figd-test-token-not-real';
  const text = stubFigma({ id: '1:1', name: 'Note', type: 'TEXT' });
  await assert.rejects(fetchTargets(FILE, '1:1', 1), (error) => error instanceof UsageError && error.message === 'node 1:1 holds no frame, component or component-set variant');
  assert.equal(text.api().length, 1);
  mock.restoreAll();
  const bad = stubFigma({ id: '1:1', name: 'Page', type: 'CANVAS', children: [{ id: '2:1', name: 'Home', type: 'FRAME' }] });
  await assert.rejects(fetchTargets(FILE, '1:1', 1), { message: 'node 2:1 has no absoluteBoundingBox (not a visible frame?)' });
  assert.equal(bad.api().length, 1);
});

test('refresh: with every target cached unchanged it exits 0, writes fresh copies under TMPDIR and leaves the cache as it was', async () => {
  process.env.FIGMA_TOKEN = 'figd-test-token-not-real';
  stubFigma();
  const { entries } = await fetchTargets(FILE, '1:1', 1);
  for (const e of entries) writeCache(cacheDir(FILE, e.target.node), e);
  const before = entries.map((e) => fs.readFileSync(path.join(cacheDir(FILE, e.target.node), 'meta.json'), 'utf8'));
  const logs = mock.method(console, 'log', () => {});
  assert.equal(await refresh(['--file', FILE, '--node', '1-1']), 0);
  const last = String(logs.mock.calls.at(-1).arguments[0]);
  assert.match(last, /^refresh 1:1: 3 unchanged; fresh copies: /);
  assert.ok(last.includes(path.join(root(), 'tmp', 'ui-check-refresh-')));
  assert.deepEqual(entries.map((e) => fs.readFileSync(path.join(cacheDir(FILE, e.target.node), 'meta.json'), 'utf8')), before);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('figd-test-token-not-real'));
});
