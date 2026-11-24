// Purpose: browser-free tests for lib/crops.mjs: cropTiles adds an 8 px margin clipped at the image edge and cuts a region larger
// than MAX_CROP_EDGE into a row-major grid of exact tiles; writeCrops writes those tiles 1:1 from a pngjs image. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import pngjs from 'pngjs';
import { cropTiles, MAX_CROP_EDGE, writeCrops } from '../lib/crops.mjs';
import { UsageError } from '../lib/errors.mjs';
import { isolateEach } from './isolated-env.mjs';

const { PNG } = pngjs;
const root = isolateEach('crops');
const MARGIN = 8; // lib/crops.mjs CROP_MARGIN
const CHANNEL_WRAP = 256;

/** A PNG whose red channel is x % 256 and green channel is y % 256, so every crop pixel says where it came from. */
function gradientPng(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) png.data.set([x % CHANNEL_WRAP, y % CHANNEL_WRAP, 0, 255], (y * width + x) * 4);
  }
  return png;
}

function writeGradient(width, height) {
  const file = path.join(root(), 'actual.png');
  fs.writeFileSync(file, PNG.sync.write(gradientPng(width, height)));
  return file;
}

const pixelAt = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('MAX_CROP_EDGE is 2576 px, the long edge a vision model sees unshrunk', () => {
  assert.equal(MAX_CROP_EDGE, 2576);
});

test('cropTiles: a small region inside the image is one tile grown by the margin on every side', () => {
  assert.deepEqual(cropTiles({ x: 20, y: 30, w: 10, h: 5 }, { width: 100, height: 100 }), [{ x: 12, y: 22, w: 26, h: 21 }]);
});

test('cropTiles: the margin is clipped at all four image edges', () => {
  assert.deepEqual(cropTiles({ x: 2, y: 3, w: 10, h: 10 }, { width: 15, height: 15 }), [{ x: 0, y: 0, w: 15, h: 15 }]);
  assert.deepEqual(cropTiles({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 }), [{ x: 0, y: 0, w: 1, h: 1 }]);
});

test('cropTiles: a wide region splits into MAX_CROP_EDGE tiles plus the rest, left to right', () => {
  assert.deepEqual(cropTiles({ x: 0, y: 0, w: 6000, h: 100 }, { width: 6000, height: 200 }), [
    { x: 0, y: 0, w: MAX_CROP_EDGE, h: 100 + MARGIN },
    { x: MAX_CROP_EDGE, y: 0, w: MAX_CROP_EDGE, h: 100 + MARGIN },
    { x: 2 * MAX_CROP_EDGE, y: 0, w: 6000 - 2 * MAX_CROP_EDGE, h: 100 + MARGIN },
  ]);
});

test('cropTiles: a region large on both axes is a row-major grid; every tile edge stays within MAX_CROP_EDGE', () => {
  const tiles = cropTiles({ x: 100, y: 100, w: 2600, h: 2600 }, { width: 5000, height: 5000 });
  const start = 100 - MARGIN;
  const rest = 2600 + 2 * MARGIN - MAX_CROP_EDGE;
  assert.deepEqual(tiles, [
    { x: start, y: start, w: MAX_CROP_EDGE, h: MAX_CROP_EDGE },
    { x: start + MAX_CROP_EDGE, y: start, w: rest, h: MAX_CROP_EDGE },
    { x: start, y: start + MAX_CROP_EDGE, w: MAX_CROP_EDGE, h: rest },
    { x: start + MAX_CROP_EDGE, y: start + MAX_CROP_EDGE, w: rest, h: rest },
  ]);
});

test('cropTiles: a region whose width with margins is exactly MAX_CROP_EDGE is one tile; one px more makes a second 1 px tile', () => {
  const size = { width: 4000, height: 50 };
  const fits = MAX_CROP_EDGE - 2 * MARGIN;
  assert.deepEqual(cropTiles({ x: 100, y: 10, w: fits, h: 4 }, size), [{ x: 92, y: 2, w: MAX_CROP_EDGE, h: 20 }]);
  assert.deepEqual(cropTiles({ x: 100, y: 10, w: fits + 1, h: 4 }, size), [
    { x: 92, y: 2, w: MAX_CROP_EDGE, h: 20 },
    { x: 92 + MAX_CROP_EDGE, y: 2, w: 1, h: 20 },
  ]);
});

test('cropTiles: a region that lies wholly outside the image gives no tile', () => {
  assert.deepEqual(cropTiles({ x: 50, y: 0, w: 5, h: 5 }, { width: 40, height: 40 }), []);
});

test('writeCrops: writes crop-1.png at native scale with the pixels of the clipped tile', () => {
  const file = writeGradient(30, 20);
  const out = path.join(root(), 'crops');
  fs.mkdirSync(out);
  const written = writeCrops(file, { x: 10, y: 5, w: 4, h: 3 }, out);
  assert.deepEqual(written, [path.join(out, 'crop-1.png')]);
  const crop = PNG.sync.read(fs.readFileSync(written[0]));
  assert.deepEqual([crop.width, crop.height], [20, 16]); // x 2..22, y 0 (clipped) ..16
  assert.deepEqual(pixelAt(crop, 0, 0), [2, 0, 0, 255]);
  assert.deepEqual(pixelAt(crop, 19, 15), [21, 15, 0, 255]);
});

test('writeCrops: a region wider than MAX_CROP_EDGE gives crop-1 and crop-2, each 1:1 from its own tile', () => {
  const width = MAX_CROP_EDGE + 24;
  const file = writeGradient(width, 1);
  const written = writeCrops(file, { x: 0, y: 0, w: width, h: 1 }, root());
  assert.deepEqual(written, [path.join(root(), 'crop-1.png'), path.join(root(), 'crop-2.png')]);
  const [first, second] = written.map((crop) => PNG.sync.read(fs.readFileSync(crop)));
  assert.deepEqual([first.width, first.height, second.width, second.height], [MAX_CROP_EDGE, 1, 24, 1]);
  assert.deepEqual(pixelAt(second, 0, 0), [MAX_CROP_EDGE % CHANNEL_WRAP, 0, 0, 255]);
});

test('writeCrops: a missing capture is a UsageError naming the file', () => {
  const missing = path.join(root(), 'absent.png');
  assert.throws(() => writeCrops(missing, { x: 0, y: 0, w: 1, h: 1 }, root()), (error) => error instanceof UsageError && error.message.includes(missing));
});
