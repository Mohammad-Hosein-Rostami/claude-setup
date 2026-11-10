// Purpose: PNG read/write, padding to a common size and diff-region scan.
// Exports: readPng, writePng, padTo, diffRegion. Invariant: padding is transparent so extra area counts as a diff.
import fs from 'node:fs';
import pngjs from 'pngjs';
import { UsageError } from './errors.mjs';

const { PNG } = pngjs;
const CHANNELS = 4;
const CHANNEL_DELTA = 26; // ~0.1 of 255, mirrors the odiff threshold

/** Decode a PNG file. @throws {UsageError} if the file is missing. */
export function readPng(file) {
  if (!fs.existsSync(file)) throw new UsageError(`image not found: ${file}`);
  return PNG.sync.read(fs.readFileSync(file));
}

/** Encode and write a PNG. */
export function writePng(file, png) {
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Return a copy of `png` on a transparent canvas of width x height (source at 0,0). */
export function padTo(png, width, height) {
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

function pixelDiffers(a, b, offset) {
  for (let c = 0; c < CHANNELS; c += 1) {
    if (Math.abs(a.data[offset + c] - b.data[offset + c]) > CHANNEL_DELTA) return true;
  }
  return false;
}

/**
 * Bounding box of differing pixels, scanning only `rows` (or every row when omitted).
 * @param {object} a PNG
 * @param {object} b PNG of the same size
 * @param {number[]} [rows] candidate rows, e.g. odiff's diffLines
 * @returns {{x: number, y: number, w: number, h: number} | null} null when nothing differs
 */
export function diffRegion(a, b, rows) {
  const candidates = rows ?? Array.from({ length: a.height }, (_, i) => i);
  let box = null;
  for (const y of candidates) {
    if (y < 0 || y >= a.height) continue;
    for (let x = 0; x < a.width; x += 1) {
      if (!pixelDiffers(a, b, (y * a.width + x) * CHANNELS)) continue;
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
  }
  return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 } : null;
}
