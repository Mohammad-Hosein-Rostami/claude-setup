// Purpose: cut the failing region of a capture into crops a model may look at: native scale (1:1 device pixels, never resized) and
// at most 2,576 px on the long edge (a larger region is cut into a grid of tiles), because a larger image reaches the model shrunk
// and loses 1-px detail (spec-p2-pixel.md F1 image rule). Exports: MAX_CROP_EDGE, cropTiles, writeCrops.
// Invariants: crops explain a failing row; they never decide PASS or FAIL (the numbers do). Pure apart from writing the PNG files.
import path from 'node:path';
import pngjs from 'pngjs';
import { readPng, writePng } from './image.mjs';

const { PNG } = pngjs;
export const MAX_CROP_EDGE = 2576; // px, long edge the vision model sees unshrunk
const CROP_MARGIN = 8; // device px of context around the region, clipped to the image

/**
 * Tiles that cover a region (plus a small margin), each at most MAX_CROP_EDGE wide and high.
 * @param {{x: number, y: number, w: number, h: number}} region diff region in device pixels
 * @param {{width: number, height: number}} size image size
 * @returns {{x: number, y: number, w: number, h: number}[]} tiles inside the image
 */
export function cropTiles(region, { width, height }) {
  const x0 = Math.max(0, region.x - CROP_MARGIN);
  const y0 = Math.max(0, region.y - CROP_MARGIN);
  const x1 = Math.min(width, region.x + region.w + CROP_MARGIN);
  const y1 = Math.min(height, region.y + region.h + CROP_MARGIN);
  const tiles = [];
  for (let y = y0; y < y1; y += MAX_CROP_EDGE) {
    for (let x = x0; x < x1; x += MAX_CROP_EDGE) tiles.push({ x, y, w: Math.min(MAX_CROP_EDGE, x1 - x), h: Math.min(MAX_CROP_EDGE, y1 - y) });
  }
  return tiles;
}

/**
 * Write the crops of one failing region of `file` into outDir as crop-<n>.png.
 * @param {string} file capture (actual.png) at device pixels
 * @param {{x: number, y: number, w: number, h: number}} region diff region
 * @param {string} outDir existing folder
 * @returns {string[]} the crop paths
 */
export function writeCrops(file, region, outDir) {
  const image = readPng(file);
  return cropTiles(region, image).map((tile, index) => {
    const crop = new PNG({ width: tile.w, height: tile.h });
    PNG.bitblt(image, crop, tile.x, tile.y, tile.w, tile.h, 0, 0);
    const out = path.join(outDir, `crop-${index + 1}.png`);
    writePng(out, crop);
    return out;
  });
}
