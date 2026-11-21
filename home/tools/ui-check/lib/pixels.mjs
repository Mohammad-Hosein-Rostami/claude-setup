// Purpose: the pixel gate - odiff (threshold 0.1, anti-aliasing ignored) with size-mismatch padding.
// Exports: pixelCheck, colorDrift. Invariants: a size mismatch always fails the gate, but the padded diff is still produced; the colour
// metric (any channel > 2, M1) runs on every compare beside odiff and fails the gate above the same pixel limit.
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { readPng, writePng, padTo, diffRegion } from './image.mjs';
import { PIXEL } from './tolerances.mjs';

async function loadOdiff() {
  try {
    const mod = await import('odiff-bin');
    return mod.compare ?? mod.default?.compare;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new UsageError('odiff-bin is not installed (run pnpm install in the ui-check folder)');
    throw error;
  }
}

// `copies`: write the aligned images to new files even when the sizes match (the bands mask must never touch the cache's baseline).
function alignSizes(baselineFile, actualFile, outDir, copies = false) {
  const base = readPng(baselineFile);
  const actual = readPng(actualFile);
  if (base.width === actual.width && base.height === actual.height && !copies) {
    return { baseFile: baselineFile, actualFile, base, actual, sizeMismatch: null };
  }
  if (base.width === actual.width && base.height === actual.height) {
    return { baseFile: path.join(outDir, 'baseline.masked.png'), actualFile: path.join(outDir, 'actual.masked.png'), base, actual, sizeMismatch: null };
  }
  const width = Math.max(base.width, actual.width);
  const height = Math.max(base.height, actual.height);
  const paddedBase = padTo(base, width, height);
  const paddedActual = padTo(actual, width, height);
  const baseFile = path.join(outDir, 'baseline.padded.png');
  const paddedFile = path.join(outDir, 'actual.padded.png');
  writePng(baseFile, paddedBase);
  writePng(paddedFile, paddedActual);
  return {
    baseFile, actualFile: paddedFile, base: paddedBase, actual: paddedActual,
    sizeMismatch: { baseline: [base.width, base.height], actual: [actual.width, actual.height] },
  };
}

const DRIFT_CHANNEL_DELTA = 2; // M1: any channel off by more than 2 levels counts, anti-aliasing included (odiff's 0.1 threshold hides a uniform drift up to ~26)

const insideAny = (x, y, boxes) => boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

/**
 * M1, the colour metric: pixels where any channel differs by more than 2 levels. In a default run the pixels inside Figma TEXT
 * boxes are left out (text anti-aliasing); under the strict rule every pixel counts (fail closed until attribution classes them).
 * @param {object} base PNG
 * @param {object} actual PNG of the same size
 * @param {{x: number, y: number, w: number, h: number}[]} excluded boxes in device pixels to leave out
 * @returns {{count: number, percent: number}}
 */
export function colorDrift(base, actual, excluded) {
  let count = 0;
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const offset = (y * base.width + x) * 4;
      const off = [0, 1, 2, 3].some((c) => Math.abs(base.data[offset + c] - actual.data[offset + c]) > DRIFT_CHANNEL_DELTA);
      if (off && !insideAny(x, y, excluded)) count += 1;
    }
  }
  return { count, percent: (count / (base.width * base.height)) * 100 };
}

/** Paint the ignored bands (diagnostic states only) the same in both images, so they never count. Bands are device-pixel {y, h}. */
function maskBands(aligned, bands) {
  for (const { y, h } of bands) {
    for (let row = Math.max(0, y); row < Math.min(aligned.base.height, y + h); row += 1) {
      const start = row * aligned.base.width * 4;
      aligned.actual.data.copy(aligned.base.data, start, start, start + aligned.base.width * 4);
    }
  }
}

/** The effect region (render bounds outside the node box: ring, outside stroke, shadow) judged on its own: its share of the region's area. */
function effectRegion(aligned, nodeBox) {
  if (!nodeBox) return null;
  const drift = colorDrift(aligned.base, aligned.actual, [nodeBox]);
  const area = aligned.base.width * aligned.base.height - nodeBox.w * nodeBox.h;
  return area > 0 ? { count: drift.count, percent: (drift.count / area) * 100 } : null;
}

/**
 * Diff the captured element against the Figma baseline.
 * @param {{baselineFile: string, actualFile: string, outDir: string, maxDiffPercent: number, textBoxes?: object[], strict?: boolean, bands?: object[], nodeBox?: object|null}} opts
 *   textBoxes = Figma TEXT boxes in device pixels (left out of the colour metric in a default run); strict = the strict rule (P3f);
 *   bands = ignored bands {y, h} in device pixels (diagnostic states); nodeBox = the node's box inside a render-bounds capture, so the
 *   area outside it (the effect region) is judged on its own
 * @returns {Promise<{pass: boolean, diffPercent: number, diffCount: number, drift: {count: number, percent: number, scope: string}, region: object | null, sizeMismatch: object | null, diffFile: string}>}
 *   pass needs the odiff share and the colour-metric share both at most maxDiffPercent
 * @throws {UsageError} if odiff-bin is not installed
 */
export async function pixelCheck({ baselineFile, actualFile, outDir, maxDiffPercent, textBoxes = [], strict = false, bands = [], nodeBox = null }) {
  const compare = await loadOdiff();
  const aligned = alignSizes(baselineFile, actualFile, outDir, bands.length > 0);
  if (bands.length > 0) {
    maskBands(aligned, bands);
    writePng(aligned.baseFile, aligned.base);
    writePng(aligned.actualFile, aligned.actual);
  }
  const diffFile = path.join(outDir, 'diff.png');
  const result = await compare(aligned.baseFile, aligned.actualFile, diffFile, {
    threshold: PIXEL.threshold, antialiasing: true, captureDiffLines: true, failOnLayoutDiff: false,
  });
  // Any non-pixel failure (missing file, layout diff) must not read as "0 different pixels".
  if (!result.match && result.reason !== 'pixel-diff') throw new UsageError(`odiff failed: ${result.reason} ${result.file ?? ''}`.trim());
  const total = aligned.base.width * aligned.base.height;
  const diffCount = result.match ? 0 : (result.diffCount ?? 0);
  const diffPercent = (diffCount / total) * 100;
  const drift = { ...colorDrift(aligned.base, aligned.actual, strict ? [] : textBoxes), scope: strict ? 'every pixel (strict)' : 'outside Figma TEXT boxes' };
  const region = result.match && drift.count === 0 ? null : diffRegion(aligned.base, aligned.actual, result.match ? undefined : result.diffLines);
  const effect = effectRegion(aligned, nodeBox);
  const pass = !aligned.sizeMismatch && diffPercent <= maxDiffPercent && drift.percent <= maxDiffPercent && (effect?.percent ?? 0) <= maxDiffPercent;
  return { pass, diffPercent, diffCount, drift, effect, region, sizeMismatch: aligned.sizeMismatch, diffFile };
}
