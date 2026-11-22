// Purpose: browser-free tests for `figma-pull --from-export` reading Figma's own PNG export (lib/native-export.mjs) and for
// the older nodes.json + `<id>.png` folder still working. Each run uses a temp HOME, so the real ~/.cache/figma is never touched.
// Exports: none.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const FILE_KEY = 'FILEKEY';
const EXIT_USAGE = 2;

const png = (shade) => {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(shade);
  return PNG.sync.write(image);
};
const frame = (id, name) => ({ id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [] });

/** A temp HOME and a helper that runs the CLI with it; `cache` is where figma-pull writes. */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-native-export-'));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const cache = (nodeDir) => path.join(home, '.cache', 'figma', FILE_KEY, nodeDir);
  return { home, run, cache };
}

/** Seed the cache the old way: a nodes.json with one page holding the given frames, one `<id>.png` per frame. */
function seedCache(box, frames) {
  const dir = path.join(box.home, 'seed');
  fs.mkdirSync(dir);
  const page = { id: '12:1', name: 'Page', type: 'CANVAS', children: frames.map(([id, name]) => frame(id, name)) };
  fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify({ nodes: { '12:1': { document: page } } }));
  for (const [id] of frames) fs.writeFileSync(path.join(dir, `${id.replace(':', '-')}.png`), png(10));
  return box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
}

function exportFolder(box, files) {
  const dir = path.join(box.home, 'figma-export');
  for (const [relative, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), bytes);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const cacheFiles = (box) => fs.readdirSync(path.join(box.home, '.cache', 'figma', FILE_KEY)).sort().flatMap((node) => ['baseline.png', 'meta.json'].map((name) => fs.readFileSync(path.join(box.cache(node), name)).toString('hex')));

test('old nodes.json + <id>.png folder still fills the cache', () => {
  const box = sandbox();
  const seeded = seedCache(box, [['12:41', 'Card']]);
  assert.equal(seeded.status, 0, seeded.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(box.cache('12-41'), 'meta.json'), 'utf8'));
  assert.equal(meta.source, 'export');
  assert.deepEqual(fs.readFileSync(path.join(box.cache('12-41'), 'baseline.png')), png(10));
});

test('native export: names map to nodes, "/" is a subfolder, @2x sets the scale', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Buttons/Primary'], ['12:42', 'Card']]).status, 0);
  const dir = exportFolder(box, { 'Buttons/Primary.png': png(50), 'Card@2x.png': png(60) });
  const result = box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(box.cache('12-41'), 'baseline.png')), png(50));
  assert.deepEqual(fs.readFileSync(path.join(box.cache('12-42'), 'baseline.png')), png(60));
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.cache('12-41'), 'meta.json'), 'utf8')).scale, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.cache('12-42'), 'meta.json'), 'utf8')).scale, 2);
  assert.ok(fs.existsSync(path.join(box.cache('12-42'), 'spec.json')));
});

test('native export with no earlier --bulk cache exits 2 and says to pull first', () => {
  const box = sandbox();
  const dir = exportFolder(box, { 'Card.png': png(60) });
  const result = box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
  assert.equal(result.status, EXIT_USAGE);
  assert.match(result.stderr, /no cache for file FILEKEY; run `figma-pull --bulk/);
});

test('a file with no layer of that name is refused with its name listed, and nothing is written', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Card']]).status, 0);
  const before = cacheFiles(box);
  const dir = exportFolder(box, { 'Card.png': png(60), 'Nope.png': png(70), 'sub/Other.png': png(80) });
  const result = box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
  assert.equal(result.status, EXIT_USAGE);
  assert.match(result.stderr, /2 files have no layer.*"Nope\.png", "sub\/Other\.png"/);
  assert.deepEqual(cacheFiles(box), before);
});

test('two cached layers with one name are refused with the name listed, and nothing is written', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Card'], ['12:42', 'Card']]).status, 0);
  const before = cacheFiles(box);
  const dir = exportFolder(box, { 'Card.png': png(60) });
  const result = box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
  assert.equal(result.status, EXIT_USAGE);
  assert.match(result.stderr, /used by more than one cached node.*"Card"/);
  assert.deepEqual(cacheFiles(box), before);
});

test('two files for one layer are refused, and nothing is written', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Card']]).status, 0);
  const before = cacheFiles(box);
  const dir = exportFolder(box, { 'Card.png': png(60), 'Card@2x.png': png(70) });
  const result = box.run('figma-pull', '--from-export', dir, '--file', FILE_KEY);
  assert.equal(result.status, EXIT_USAGE);
  assert.match(result.stderr, /more than one file for one layer/);
  assert.deepEqual(cacheFiles(box), before);
});

test('an empty folder, a 0-byte PNG and a non-PNG exit 2 with the reason', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Card']]).status, 0);
  const before = cacheFiles(box);
  const empty = box.run('figma-pull', '--from-export', exportFolder(box, {}), '--file', FILE_KEY);
  assert.equal(empty.status, EXIT_USAGE);
  assert.match(empty.stderr, /holds no PNG files/);
  fs.rmSync(path.join(box.home, 'figma-export'), { recursive: true });
  const zero = box.run('figma-pull', '--from-export', exportFolder(box, { 'Card.png': Buffer.alloc(0) }), '--file', FILE_KEY);
  assert.equal(zero.status, EXIT_USAGE);
  assert.match(zero.stderr, /"Card\.png" is empty \(0 bytes\)/);
  fs.rmSync(path.join(box.home, 'figma-export'), { recursive: true });
  const text = box.run('figma-pull', '--from-export', exportFolder(box, { 'Card.png': Buffer.from('not a png at all') }), '--file', FILE_KEY);
  assert.equal(text.status, EXIT_USAGE);
  assert.match(text.stderr, /"Card\.png" is not a PNG/);
  assert.deepEqual(cacheFiles(box), before);
});

test('file names are capped: a name over 200 characters is refused, control characters in a listed name are escaped', () => {
  const box = sandbox();
  assert.equal(seedCache(box, [['12:41', 'Card']]).status, 0);
  const long = box.run('figma-pull', '--from-export', exportFolder(box, { [`${'a'.repeat(210)}.png`]: png(60) }), '--file', FILE_KEY);
  assert.equal(long.status, EXIT_USAGE);
  assert.match(long.stderr, /longer than 200 characters/);
  fs.rmSync(path.join(box.home, 'figma-export'), { recursive: true });
  const odd = box.run('figma-pull', '--from-export', exportFolder(box, { 'a\u001b[31m$(touch x).png': png(60) }), '--file', FILE_KEY);
  assert.equal(odd.status, EXIT_USAGE);
  assert.ok(!odd.stderr.includes('\u001b'), 'escape character must not reach the terminal');
  assert.match(odd.stderr, /\\u001b\[31m\$\(touch x\)/);
});
